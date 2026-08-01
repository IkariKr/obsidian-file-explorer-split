import { App, normalizePath } from "obsidian";

export class MoveDiagnostics {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: App,
    private readonly pluginId: string,
  ) {}

  get path(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}/debug.log`);
  }

  async start(): Promise<void> {
    await this.app.vault.adapter.write(this.path, `# File Explorer Split diagnostics\n# Session started ${new Date().toISOString()}\n`);
    this.log("session.started", { logPath: this.path });
  }

  log(event: string, details: unknown = {}): void {
    const entry = {
      timestamp: new Date().toISOString(),
      event,
      details,
    };
    console.info("[File Explorer Split]", entry);
    this.writeQueue = this.writeQueue
      .then(() => this.app.vault.adapter.append(this.path, `${JSON.stringify(entry)}\n`))
      .catch((error: unknown) => console.error("[File Explorer Split] Failed to write diagnostics", error));
  }

  error(event: string, error: unknown, details: unknown = {}): void {
    this.log(event, {
      ...asObject(details),
      error: error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    });
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { details: value };
}
