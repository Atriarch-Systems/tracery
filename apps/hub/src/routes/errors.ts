/** Shared `{ error: { code, message } }` body shape (SPEC.md §6). */
export interface ErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

export function errorBody(code: string, message: string): ErrorBody {
  return { error: { code, message } };
}
