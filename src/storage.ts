// Small persistent key-value store: localStorage on the web, a JSON file in the user's preferences directory natively.

export interface Storage {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
}
