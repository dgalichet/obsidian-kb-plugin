/** The service does not implement the current-note publication endpoint. */
export class WorkspaceContextUnsupportedError extends Error {
  constructor() {
    super("The service does not support current note sharing");
    this.name = "WorkspaceContextUnsupportedError";
  }
}
