export const sep = '/';
export const dirname = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
export const join = (...p: string[]) => p.join('/').replace(/\/+/g, '/');
export const resolve = join;
