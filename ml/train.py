"""Train and evaluate tabular classifiers on one input snapshot."""
import json
import math
import sys
from collections import Counter


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


def evaluate(payload):
    try:
        import numpy as np
        from sklearn.compose import ColumnTransformer
        from sklearn.dummy import DummyClassifier
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression
        from sklearn.metrics import accuracy_score, balanced_accuracy_score, confusion_matrix, f1_score
        from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold, cross_val_predict
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import LabelEncoder, OneHotEncoder, StandardScaler
    except ImportError as error:
        raise TrainingError("ML_RUNTIME", "训练依赖未安装。") from error

    columns = payload["columns"]
    convert = [numeric if column["kind"] == "number" else category for column in columns]
    features, labels = [], []
    for raw in payload["rows"]:
        label = category(raw[0])
        if label is None:
            continue
        features.append(tuple(parse(value) for parse, value in zip(convert, raw[1:], strict=True)))
        labels.append(label)

    counts = Counter(labels)
    if len(counts) < 2 or len(counts) > 8:
        raise TrainingError("ML_LABELS", "请选择有 2～8 个类别的目标列。当前训练功能适用于分类。")
    if len(labels) < 30 or min(counts.values()) < 5:
        raise TrainingError("ML_LABELS", "训练至少需要 30 条有标签的记录，每个类别至少 5 条。")

    for i, column in enumerate(columns):
        values = {row[i] for row in features}
        if None in values or len(values) != len(counts):
            continue
        pairs = {(row[i], label) for row, label in zip(features, labels, strict=True)}
        if len(pairs) == len(counts):
            raise TrainingError(
                "ML_LABEL_LEAKAGE",
                f"特征「{column['name'][:100]}」与目标标签一一对应，可能是标签副本或由标签生成。请核对来源，并提供可在预测前取得的特征。",
            )

    x = np.asarray([[np.nan if value is None else value for value in row] for row in features], dtype=object)
    encoder = LabelEncoder()
    y = encoder.fit_transform(labels)
    # Identical feature vectors should not appear on both sides of a validation fold.
    group_ids = {}
    groups = np.asarray([group_ids.setdefault(row, len(group_ids)) for row in features])
    grouped = len(group_ids) < len(features)
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
    models = [
        ("majority", DummyClassifier(strategy="most_frequent")),
        ("logistic", LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)),
        ("forest", RandomForestClassifier(n_estimators=100, max_depth=12, min_samples_leaf=2, class_weight="balanced", n_jobs=1, random_state=42)),
    ]
    scores, predictions = [], {}
    for name, estimator in models:
        # Pipeline is cloned and fitted inside each fold by cross_val_predict.
        model = Pipeline([("prepare", preprocessing), ("classifier", estimator)])
        predicted = cross_val_predict(model, x, y, cv=fold_indices, n_jobs=1)
        predictions[name] = predicted
        scores.append({
            "model": name,
            "accuracy": accuracy_score(y, predicted),
            "balancedAccuracy": balanced_accuracy_score(y, predicted),
            "macroF1": f1_score(y, predicted, average="macro", zero_division=0),
        })

    selected = max(scores[1:], key=lambda score: score["macroF1"])["model"]
    return {
        "rows": len(labels),
        "missingLabels": len(payload["rows"]) - len(labels),
        "features": len(columns),
        "folds": len(fold_indices),
        "grouped": grouped,
        "labels": encoder.classes_.tolist(),
        "scores": scores,
        "selected": selected,
        "confusion": confusion_matrix(y, predictions[selected], labels=range(n_classes)).tolist(),
    }


if __name__ == "__main__":
    try:
        print(json.dumps({"report": evaluate(json.load(sys.stdin))}, ensure_ascii=False, allow_nan=False))
    except TrainingError as error:
        print(json.dumps({"error": {"code": error.code, "message": str(error)}}, ensure_ascii=False))
