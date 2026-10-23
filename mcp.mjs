// A small MCP client: enough of the protocol to list a server's tools and call
// them, over stdio or streamable HTTP. Servers that authenticate with a header
// work; servers that need an OAuth sign-in do not, and belong with the Oracle.

import { spawn } from "node:child_process";

const PROTOCOL = "2025-06-18";

export class McpClient {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.nextId = 1;
    this.waiting = new Map();
    this.headers = {};
  }

  async start() {
    if (this.spec.command) this.startProcess();
    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "heymorgan", version: "0.1" },
    });
    if (init.protocolVersion) this.headers["MCP-Protocol-Version"] = init.protocolVersion;
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = [];
    let cursor;
    do {
      const page = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async call(tool, args) {
    const result = await this.request("tools/call", { name: tool, arguments: args ?? {} });
    const text = (result.content ?? [])
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n");
    const body = text || JSON.stringify(result.structuredContent ?? {});
    return result.isError ? `The tool reported an error: ${body}` : body;
  }

  stop() {
    this.child?.kill("SIGTERM");
  }

  startProcess() {
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...this.spec.env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.settle(JSON.parse(line)); } catch { /* not a JSON line */ }
      }
    });
    const lost = (reason) => {
      for (const { reject } of this.waiting.values()) reject(new Error(`${this.name}: ${reason}`));
      this.waiting.clear();
    };
    child.on("error", (error) => lost(error.message));
    child.on("exit", (code) => lost(`server exited (code ${code})`));
  }

  settle(message) {
    const waiter = this.waiting.get(message.id);
    if (!waiter || (!("result" in message) && !message.error)) return;
    this.waiting.delete(message.id);
    if (message.error) waiter.reject(new Error(`${this.name}: ${message.error.message}`));
    else waiter.resolve(message.result);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        this.waiting.delete(id);
        reject(error);
      });
    });
  }

  async send(message) {
    if (this.child) {
      this.child.stdin.write(JSON.stringify(message) + "\n");
      return;
    }
    const response = await fetch(this.spec.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...this.spec.headers,
        ...this.headers,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${this.name}: HTTP ${response.status}`);
    const session = response.headers.get("mcp-session-id");
    if (session) this.headers["Mcp-Session-Id"] = session;
    const body = await response.text();
    if (!body.trim()) return;
    if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for (const line of body.split("\n")) {
        if (line.startsWith("data:")) { try { this.settle(JSON.parse(line.slice(5))); } catch { /* keep-alive */ } }
      }
    } else {
      this.settle(JSON.parse(body));
    }
  }
}
