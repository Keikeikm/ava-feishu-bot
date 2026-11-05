"""Evaluate tabular models and optionally predict a separate submission set."""
import csv
import io
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path


class TrainingError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def numeric(value):
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def category(value):
    if value is None or isinstance(value, (dict, list)):
        return None
    return str(value).strip() or None


def evaluate(payload, predict_rows=None):
    try:
        import numpy as np
        from sklearn.compose import ColumnTransformer
        from sklearn.dummy import DummyClassifier, DummyRegressor
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression, Ridge
        from sklearn.metrics import (
            accuracy_score, balanced_accuracy_score, confusion_matrix, f1_score,
            mean_absolute_error, r2_score, root_mean_squared_error,
        )
        from sklearn.model_selection import GroupKFold, KFold, StratifiedGroupKFold, StratifiedKFold, cross_val_predict
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler
    except ImportError as error:
        raise TrainingError("ML_RUNTIME", "训练依赖未安装。") from error

    columns = payload["columns"]
    task = payload["task"]
    regression = task == "regression"
    convert = [numeric if column["kind"] == "number" else category for column in columns]
    features, labels = [], []
    for raw in payload["rows"]:
        label = raw[0] if regression else category(raw[0])
        if label is None or (isinstance(label, str) and not label.strip()):
            continue
        if regression:
            label = None if isinstance(label, bool) else numeric(label)
            if label is None:
                raise TrainingError("ML_LABELS", "回归目标列需要是数值，请检查这一列是否含有非数值内容。")
        features.append(tuple(parse(value) for parse, value in zip(convert, raw[1:], strict=True)))
        labels.append(label)

    counts = Counter(labels)
    if regression:
        if len(labels) < 30 or len(counts) < 2:
            raise TrainingError("ML_LABELS", "回归训练至少需要 30 条有目标值的记录，且目标值需要有变化。")
    else:
        if len(counts) < 2 or len(counts) > 8:
            raise TrainingError("ML_LABELS", "分类目标列需要有 2～8 个类别。若要预测连续数值，请发送 /训练 目标列 --回归。")
        if len(labels) < 30 or min(counts.values()) < 5:
            raise TrainingError("ML_LABELS", "训练至少需要 30 条有标签的记录，每个类别至少 5 条。")

    for i, column in enumerate(columns):
        if regression:
            leakage = all(numeric(row[i]) == label for row, label in zip(features, labels, strict=True))
        else:
            values = {row[i] for row in features}
            pairs = {(row[i], label) for row, label in zip(features, labels, strict=True)}
            leakage = None not in values and len(values) == len(pairs) == len(counts)
        if leakage:
            raise TrainingError(
                "ML_LABEL_LEAKAGE",
                f"特征「{column['name'][:100]}」可能是目标列的副本或由目标值生成。请核对来源，并提供可在预测前取得的特征。",
            )

    x = np.asarray([[np.nan if value is None else value for value in row] for row in features], dtype=object)
    # Identical feature vectors should not appear on both sides of a validation fold.
    group_ids = {}
    groups = np.asarray([group_ids.setdefault(row, len(group_ids)) for row in features])
    grouped = len(group_ids) < len(features)
    if regression:
        if len(group_ids) < 2:
            raise TrainingError("ML_SPLIT", "无法划分回归验证集。请补充特征取值不同的样本。")
        y = np.asarray(labels)
        splitter = GroupKFold if grouped else KFold
        cv = splitter(n_splits=min(5, len(group_ids)), shuffle=True, random_state=42)
        fold_indices = list(cv.split(x, y, groups if grouped else None))
        models = [
            ("median", DummyRegressor(strategy="median")),
            ("ridge", Ridge()),
            ("forest", RandomForestRegressor(n_estimators=100, max_depth=12, min_samples_leaf=2, n_jobs=1, random_state=42)),
        ]
    else:
        encoder = LabelEncoder()
        y = encoder.fit_transform(labels)
        n_classes = len(counts)
        fold_indices = None
        for folds in range(min(5, min(counts.values()), len(group_ids)), 1, -1):
            splitter = StratifiedGroupKFold if grouped else StratifiedKFold
            splits = list(splitter(n_splits=folds, shuffle=True, random_state=42).split(x, y, groups if grouped else None))
            if all(len(set(y[train])) == len(set(y[valid])) == n_classes for train, valid in splits):
                fold_indices = splits
                break
        if fold_indices is None:
            raise TrainingError("ML_SPLIT", "无法分出每个类别都齐全的训练和验证集。请补充各类别的独立样本。")
        models = [
            ("majority", DummyClassifier(strategy="most_frequent")),
            ("logistic", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
            ("forest", RandomForestClassifier(n_estimators=100, max_depth=12, min_samples_leaf=2, class_weight="balanced", n_jobs=1, random_state=42)),
        ]

    numbers = [i for i, column in enumerate(columns) if column["kind"] == "number"]
    categories = [i for i, column in enumerate(columns) if column["kind"] == "category"]
    preprocessing = ColumnTransformer([
        ("number", Pipeline([
            ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("scale", StandardScaler()),
        ]), numbers),
        ("category", Pipeline([
            ("impute", SimpleImputer(strategy="constant", fill_value="(missing)", keep_empty_features=True)),
            ("encode", OneHotEncoder(handle_unknown="infrequent_if_exist", max_categories=32)),
        ]), categories),
    ])
    scores, predictions = [], {}
    for name, estimator in models:
        # Pipeline is cloned and fitted inside each fold by cross_val_predict.
        model = Pipeline([("prepare", preprocessing), ("model", estimator)])
        predicted = cross_val_predict(model, x, y, cv=fold_indices, n_jobs=1)
        predictions[name] = predicted
        if regression:
            scores.append({
                "model": name,
                "mae": mean_absolute_error(y, predicted),
                "rmse": root_mean_squared_error(y, predicted),
                "r2": r2_score(y, predicted),
            })
        else:
            scores.append({
                "model": name,
                "accuracy": accuracy_score(y, predicted),
                "balancedAccuracy": balanced_accuracy_score(y, predicted),
                "macroF1": f1_score(y, predicted, average="macro", zero_division=0),
            })

    report = {
        "task": task,
        "rows": len(labels),
        "missingLabels": len(payload["rows"]) - len(labels),
        "features": len(columns),
        "folds": len(fold_indices),
        "grouped": grouped,
        "scores": scores,
    }
    if regression:
        selected = min(scores[1:], key=lambda score: score["mae"])["model"]
    else:
        selected = max(scores[1:], key=lambda score: score["macroF1"])["model"]
        report.update({
            "labels": encoder.classes_.tolist(),
            "confusion": confusion_matrix(y, predictions[selected], labels=range(n_classes)).tolist(),
        })
    report["selected"] = selected
    if predict_rows is None:
        return report
    # Fit the chosen pipeline on all labeled training rows only.
    estimator = dict(models)[selected]
    model = Pipeline([("prepare", preprocessing), ("model", estimator)]).fit(x, y)
    test = [tuple(parse(value) for parse, value in zip(convert, row, strict=True)) for row in predict_rows]
    test_x = np.asarray([[np.nan if value is None else value for value in row] for row in test], dtype=object)
    values = model.predict(test_x)
    return report, (values if regression else encoder.inverse_transform(values)).tolist()


def read_csv(path, name):
    try:
        if Path(path).stat().st_size > 8 * 1024 * 1024:
            raise TrainingError("ML_LIMIT", f"{name} 超过 8 MB，请缩小数据范围。")
        with open(path, encoding="utf-8-sig", newline="") as file:
            return csv_rows(file, name)
    except (UnicodeError, csv.Error, OSError) as error:
        raise TrainingError("ML_CSV", f"{name} 读取失败，请检查是否为 UTF-8 CSV。") from error


def csv_rows(stream, name):
    reader = csv.reader(stream, strict=True)
    fields = next(reader, [])
    if not fields or len(fields) > 256 or not all(field.strip() for field in fields) or len(set(fields)) != len(fields):
        raise TrainingError("ML_CSV", f"{name} 需要 1～256 个非空且唯一的表头。")
    rows = []
    for row in reader:
        if not row:
            continue
        if len(row) != len(fields):
            raise TrainingError("ML_CSV", f"{name} 存在列数与表头不一致的记录。")
        if len(rows) >= 5000:
            raise TrainingError("ML_LIMIT", f"{name} 超过 5,000 行，请缩小数据范围。")
        rows.append(dict(zip(fields, row)))
    if not rows:
        raise TrainingError("ML_CSV", f"{name} 没有数据行。")
    return fields, rows


def submission(payload):
    files = payload["submission"]
    train_fields, train = read_csv(files["train"], "train.csv")
    test_fields, test = read_csv(files["test"], "test.csv")
    headers, template = read_csv(files["template"], "提交模板")

    target_name = payload.get("target")
    candidates = [column for column in headers if column in train_fields and
                  (column.casefold() == target_name.casefold() if target_name else column not in test_fields)]
    if len(candidates) != 1:
        raise TrainingError("ML_TARGET", "无法确定唯一目标列。请确认目标列出现在训练集和提交模板中，或发送 /预测 --目标 列名。")
    target = candidates[0]
    ids = [column for column in headers if column != target]
    if not ids or any(column not in test_fields for column in ids):
        raise TrainingError("ML_SUBMISSION", "提交模板需要包含测试集中的 ID 列和一个预测目标列。")

    def row_key(row):
        return tuple(row[column] for column in ids)

    test_keys = [row_key(row) for row in test]
    template_keys = [row_key(row) for row in template]
    if (any(not all(value.strip() for value in key) for key in test_keys)
            or len(set(test_keys)) != len(test_keys) or len(set(template_keys)) != len(template_keys)
            or set(test_keys) != set(template_keys)):
        raise TrainingError("ML_SUBMISSION", "测试集和提交模板的 ID 必须非空、唯一，且一一对应。")

    # Keep only features available at prediction time. Preserve raw CSV IDs for the output.
    features = [column for column in train_fields if column in test_fields and column not in ids and column != target
                and not re.search(r"(^|[_\s])id$|^(passengerid|name|full_?name|ticket|email|phone)$|编号|姓名|手机号|邮箱", column, re.I)
                and not column.endswith(("Id", "ID"))]
    if not features or len(features) > 80:
        raise TrainingError("ML_FEATURES", "训练集和测试集需要共有 1～80 个可用特征。")
    columns = []
    for column in features:
        observed = {row[column] for row in train if row[target].strip() and row[column].strip()}
        if observed:
            kind = "number" if all(numeric(value) is not None for value in observed) else "category"
            columns.append({"name": column, "kind": kind})
    if not columns:
        raise TrainingError("ML_FEATURES", "训练集的共有特征没有可用值。")
    names = [column["name"] for column in columns]
    labels = {row[target].strip() for row in train if row[target].strip()}
    task = payload.get("task") or ("regression" if len(labels) > 8 and all(numeric(label) is not None for label in labels) else "classification")
    report, values = evaluate({
        "task": task,
        "columns": columns,
        "rows": [[row[target], *(row[name] for name in names)] for row in train],
    }, [[row[name] for name in names] for row in test])

    output = io.StringIO(newline="")
    writer = csv.writer(output)
    by_id = dict(zip(test_keys, values, strict=True))
    rows = [[by_id[key] if column == target else row[column] for column in headers]
            for key, row in zip(template_keys, template, strict=True)]
    for row in [headers, *rows]:
        for value in row:
            if isinstance(value, str) and (re.search(r"[\x00-\x1f\x7f]", value)
                    or (re.match(r"\s*[=+@-]", value) and numeric(value) is None)):
                raise TrainingError("ML_SUBMISSION", "提交文件的列名、ID 或预测类别含有无法安全导出的字符。")
        writer.writerow(row)
    content = output.getvalue()
    if len(content.encode("utf-8")) > 2 * 1024 * 1024:
        raise TrainingError("ML_LIMIT", "提交文件超过 2 MB，请缩小测试集。")
    return {"report": report, "csv": content, "rows": len(rows), "target": target}


def compare(payload):
    columns, predictions = csv_rows(io.StringIO(payload["csv"], newline=""), "上一轮预测")
    reference_fields, reference = read_csv(payload["reference"], "对照 CSV")
    target = payload["target"]
    ids = [column for column in columns if column != target]
    if target not in reference_fields:
        raise TrainingError("ML_REFERENCE", f"对照 CSV 缺少目标列「{target}」。请提供包含目标值的 CSV。")
    if any(column not in reference_fields for column in ids):
        raise TrainingError("ML_REFERENCE", "对照 CSV 缺少预测提交文件中的 ID 列。")

    def index(rows):
        indexed = {}
        for row in rows:
            key = tuple(row[column] for column in ids)
            if not all(value.strip() for value in key) or key in indexed:
                raise TrainingError("ML_REFERENCE", "用于对比的 ID 必须非空且唯一。")
            value = row[target].strip()
            if not value:
                raise TrainingError("ML_REFERENCE", "对照 CSV 存在空目标值，请补全后重试。")
            indexed[key] = value
        return indexed

    predicted, expected = index(predictions), index(reference)
    if predicted.keys() != expected.keys():
        raise TrainingError("ML_REFERENCE", f"两份文件的 ID 未完全匹配：预测 {len(predicted)} 条，对照 {len(expected)} 条，匹配 {len(predicted.keys() & expected.keys())} 条。请核对是否来自同一测试集。")
    task = payload["task"]
    total = len(predicted)
    if task == "classification":
        matches = sum(value == expected[key] for key, value in predicted.items())
        return {"task": task, "total": total, "matches": matches}

    errors = []
    for key, value in predicted.items():
        a, b = numeric(value), numeric(expected[key])
        if a is None or b is None or not math.isfinite(a - b):
            raise TrainingError("ML_REFERENCE", "回归对比需要可计算误差的有限数值。")
        errors.append(abs(a - b))
    scale = max(errors)
    mae = math.fsum(error / total for error in errors)
    rmse = scale * math.sqrt(math.fsum((error / scale) ** 2 for error in errors) / total) if scale else 0
    return {"task": task, "total": total, "mae": mae, "rmse": rmse}


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        if "comparison" in payload:
            report = compare(payload["comparison"])
        elif "submission" in payload:
            report = submission(payload)
        else:
            report = evaluate(payload)
        print(json.dumps({"report": report}, ensure_ascii=False, allow_nan=False))
    except TrainingError as error:
        print(json.dumps({"error": {"code": error.code, "message": str(error)}}, ensure_ascii=False))
