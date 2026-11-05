export type FailureStage = 'download' | 'source' | 'schema' | 'profile' | 'preview' | 'analysis' | 'visualization' | 'suggest' | 'training';
export interface Failure {
  code: string;
  message: string;
  stage?: FailureStage;
  diagnostic?: { errorType: string; nativeCode?: string; httpStatus?: number; reason?: string; feishuCode?: number; requiredScopes?: string[] };
}

export class UserError extends Error {
  constructor(message: string, readonly code = 'INVALID_INPUT', readonly stage?: FailureStage, readonly diagnostic?: Failure['diagnostic']) {
    super(message);
    this.name = 'UserError';
  }
}

// AVA's Feishu loader reports the API's numeric code in its error message.
export function bitableReadError(error: unknown): UserError {
  if (error instanceof UserError) return error;
  const message = error instanceof Error ? error.message : '';
  const match = /^Feishu Error (\d+):/.exec(message);
  const feishuCode = match ? Number(match[1]) : undefined;
  const diagnostic = { errorType: 'Error', feishuCode };
  const failure = (code: string, text: string) => new UserError(text, code, 'source', diagnostic);

  if (feishuCode === 99991672) {
    const wikiScope = /\bwiki:(?:wiki(?::readonly)?|node:read)\b/.test(message);
    return failure('BITABLE_API_SCOPE', wikiScope
      ? '飞书应用缺少读取知识库节点的 API 权限。请在开放平台开通应用身份权限 wiki:wiki:readonly 并发布。'
      : '飞书应用缺少读取多维表格的 API 权限。请在开放平台开通应用身份权限 bitable:app:readonly 并发布。');
  }
  if (feishuCode === 91403 || feishuCode === 1254302) {
    return failure('BITABLE_ACCESS_DENIED', '飞书拒绝了机器人的读表请求。请在多维表格的「更多 → 添加文档应用」中授权当前机器人。开启高级权限时，请同时核对目标数据表的读取权限。');
  }
  if (feishuCode === 91402 || feishuCode === 1254040 || feishuCode === 1254041 || feishuCode === 93004) {
    return failure('BITABLE_NOT_FOUND', '飞书未找到机器人可访问的表格或知识库节点。请确认链接指向的资源仍存在，并对当前机器人应用开放。');
  }
  if (/^Feishu wiki node .* hosts a .* not a Bitable/.test(message)) {
    return failure('BITABLE_WIKI_TYPE', '这个知识库链接指向其他类型的文档。请发送多维表格所在的知识库页面或表格地址。');
  }
  if (message === 'Feishu Bitable has no supported fields') {
    return failure('BITABLE_NO_FIELDS', '没有读取到可分析的字段。请检查该数据表的字段类型，以及机器人是否能读取这些字段。');
  }
  if (/^Feishu Bitable \S+ has no tables\.$/.test(message)) {
    return failure('BITABLE_NO_TABLES', '飞书没有返回机器人可读取的数据表。请检查机器人对该多维表格的访问权限。');
  }
  if (/INSTALL sqlite|extension.*sqlite|sqlite.*extension/i.test(message)) {
    return failure('EXTENSION', '加载多张数据表需要 DuckDB 的 SQLite 扩展。请检查服务端网络后重试。');
  }
  return failure('BITABLE_READ_FAILED', feishuCode
    ? `飞书读表接口返回错误（飞书错误码 ${feishuCode}）。请将错误码提供给管理员排查。`
    : '读取多维表格失败，请检查飞书服务连接后重试。');
}

// Never send raw SDK errors to chat: they can contain tokens, file contents or model requests.
export function publicFailure(error: unknown, stage?: FailureStage): Failure {
  if (error instanceof UserError) return { code: error.code, message: error.message, stage: error.stage || stage, diagnostic: error.diagnostic };
  const obj = error as { status?: number; statusCode?: number; message?: string; code?: string } | undefined;
  const status = obj?.status || obj?.statusCode;
  const message = obj?.message || String(error);
  const nativeCode = typeof obj?.code === 'string' && /^[A-Z][A-Z0-9_]{1,50}$/.test(obj.code) ? obj.code : undefined;
  const diagnostic: NonNullable<Failure['diagnostic']> = { errorType: error instanceof SyntaxError ? 'SyntaxError' : error instanceof TypeError ? 'TypeError' : 'Error', nativeCode, httpStatus: typeof status === 'number' ? status : undefined };
  const failure = (code: string, message: string): Failure => ({ code, message, stage, diagnostic });
  if (status === 401 || status === 403 || /api.?key|unauthorized|authentication/i.test(message)) {
    return failure('MODEL_AUTH', '模型服务鉴权失败，请管理员检查 LLM_API_KEY、LLM_MODEL 和 LLM_BASE_URL。');
  }
  if (status === 429 || /rate.?limit|quota|insufficient.?balance/i.test(message)) {
    return failure('MODEL_LIMIT', '模型服务限流或额度不足，请稍后重试，或检查模型账户额度。');
  }
  if (/extension|INSTALL excel|INSTALL sqlite/i.test(message)) {
    return failure('EXTENSION', '数据引擎扩展加载失败，请检查服务器网络；也可以将文件导出为 CSV 后重试。');
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return failure('TIMEOUT', '任务超时，请缩小数据或问题范围后重试。');
  }
  if (/CSV Error|sniff|delimiter|invalid unicode|invalid utf.?8|encoding error/i.test(message)) {
    diagnostic.reason = 'CSV_FORMAT';
    return failure('CSV_FORMAT', 'CSV 解析失败，请确认文件为 UTF-8 编码、第一行是表头，且各行分隔符一致。');
  }
  if (/ENOENT|No files found|does not exist/i.test(message)) {
    diagnostic.reason = 'FILE_NOT_FOUND';
    return failure('FILE_NOT_FOUND', '下载后的数据文件不存在，请重新发送表格。');
  }
  if (/EACCES|permission denied|allowed.director|filesystem access|disabled filesystem/i.test(message)) {
    diagnostic.reason = 'FILE_ACCESS';
    return failure('FILE_ACCESS', '数据引擎无法读取本地文件，请检查 DATA_DIR 目录的访问权限。');
  }
  if (/out of memory|memory limit/i.test(message)) {
    diagnostic.reason = 'MEMORY_LIMIT';
    return failure('MEMORY_LIMIT', '数据处理超过引擎内存限制，请缩小文件或拆分工作表后重试。');
  }
  const labels: Partial<Record<FailureStage, string>> = { source: '读取文件', schema: '读取字段', profile: '统计行数与空值', preview: '生成数据预览', analysis: '执行分析', visualization: '生成图表', suggest: '生成建议', training: '准备训练数据' };
  const label = stage && labels[stage];
  return failure('ENGINE_ERROR', label ? `数据引擎在「${label}」阶段失败，请查看终端诊断日志后重试。` : '数据加载或分析失败，请检查文件格式、字段名和模型配置后重试。');
}
