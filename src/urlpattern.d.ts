// Minimal ambient declaration: URLPattern exists at runtime in Bun and
// Node >= 24 but is not yet in the bundled TS libs.
declare class URLPattern {
  constructor(init?: { pathname?: string; baseURL?: string } | string);
  test(input: string): boolean;
}
