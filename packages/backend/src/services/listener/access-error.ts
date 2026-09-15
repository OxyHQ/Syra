/** Expected boundary failures; unexpected errors still reach the server handler. */
export class ListenerAccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ListenerAccessError';
  }
}
