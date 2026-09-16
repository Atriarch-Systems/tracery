export function errorBody(code, message) {
    return { error: { code, message } };
}
