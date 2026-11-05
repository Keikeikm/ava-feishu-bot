import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.js';

const root = new URL('../../', import.meta.url);

export function runPython<T>(scriptName: 'train' | 'archive', input: unknown, timeoutMs: number, configuredPython?: string, maxOutputBytes = 65_536): Promise<T> {
  const venv = fileURLToPath(new URL('.venv/bin/python', root));
  const python = configuredPython || (existsSync(venv) ? venv : 'python3');
  const script = fileURLToPath(new URL(`ml/${scriptName}.py`, root));
  const archive = scriptName === 'archive';
  const failure = (message: string, code: string) => new UserError(message, code, archive ? 'source' : 'training');
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, PYTHONIOENCODING: 'utf-8', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' },
    });
    let output = '';
    let interrupted = false;
    let bytes = 0;
    const timeout = setTimeout(() => {
      interrupted = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) child.kill('SIGKILL');
      else output += chunk;
    });
    const unavailable = () => failure(archive ? '解压需要 Python 3，请检查 Python 安装或 ML_PYTHON 配置。' : '训练环境未就绪。请按 README 安装 Python 训练依赖。', archive ? 'ZIP_RUNTIME' : 'ML_RUNTIME');
    child.once('error', () => {
      clearTimeout(timeout);
      reject(unavailable());
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (interrupted) { reject(failure(archive ? 'ZIP 解压超时，请缩小压缩包后重试。' : '训练超时，请缩小数据范围后重试。', archive ? 'ZIP_TIMEOUT' : 'ML_TIMEOUT')); return; }
      if (code !== 0) { reject(failure(archive ? 'ZIP 读取失败，请重新压缩后上传。' : '训练进程执行失败，请检查训练环境和数据类型。', archive ? 'ZIP_INVALID' : 'ML_FAILED')); return; }
      try {
        const reply = JSON.parse(output) as { report?: T; error?: { code: string; message: string } };
        if (reply.error?.code === 'ML_RUNTIME') reject(unavailable());
        else if (reply.error) reject(failure(reply.error.message, reply.error.code));
        else if (reply.report) resolve(reply.report);
        else throw new Error('Missing training report');
      } catch {
        reject(failure(archive ? 'ZIP 读取失败，请重新压缩后上传。' : '训练进程没有返回有效的报告。', archive ? 'ZIP_INVALID' : 'ML_FAILED'));
      }
    });
    child.stdin.on('error', () => { /* Process exit reports startup and training errors. */ });
    child.stdin.end(JSON.stringify(input));
  });
}
