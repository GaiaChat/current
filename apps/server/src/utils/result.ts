export interface ServiceResult<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export function success<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function failure(code: string, message: string): ServiceResult<never> {
  return { ok: false, error: { code, message } };
}
