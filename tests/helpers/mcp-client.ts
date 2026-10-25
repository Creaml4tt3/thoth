/**
 * A minimal MCP client over stdio for tests (ADR-0021): starts `thoth-mcp` as a child process, as Claude Desktop or
 * Cursor do, and matches each answer to its request by id. Every line it reads is kept in `lines`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type Message = Record<string, unknown>;

export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<string, (message: Message) => void>();
  readonly lines: string[] = [];
  readonly exited: Promise<number | null>;

  constructor(binary: string, socket: string) {
    this.child = spawn(binary, ["--socket", socket], { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
      const message = JSON.parse(line) as Message;
      this.waiting.get(JSON.stringify(message.id ?? null))?.(message);
    });
    this.exited = new Promise((resolve) => this.child.once("exit", (code) => resolve(code)));
  }

  request(id: number | string, method: string, params?: unknown): Promise<Message> {
    const answer = new Promise<Message>((resolve) => this.waiting.set(JSON.stringify(id), resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return answer;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`);
  }

  /** The 2025-11-25 handshake, as `app` (`clientInfo.name`). */
  async initialize(app: string): Promise<Message> {
    const answer = await this.request(0, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: app, version: "1.0.0" } });
    this.notify("notifications/initialized");
    return answer;
  }

  /** Closes its input: `thoth-mcp` exits. */
  async close(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }
}
