export type FailureStage = 'download' | 'source' | 'schema' | 'profile' | 'preview' | 'analysis' | 'visualization' | 'suggest';
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
  const labels: Partial<Record<FailureStage, string>> = { source: '读取文件', schema: '读取字段', profile: '统计行数与空值', preview: '生成数据预览', analysis: '执行分析', visualization: '生成图表', suggest: '生成建议' };
  const label = stage && labels[stage];
  return failure('ENGINE_ERROR', label ? `数据引擎在「${label}」阶段失败，请查看终端诊断日志后重试。` : '数据加载或分析失败，请检查文件格式、字段名和模型配置后重试。');
}
