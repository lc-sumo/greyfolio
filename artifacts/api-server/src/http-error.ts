/** Framework-free error carrying an HTTP status. Shared by the Express routes and the in-browser demo. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
