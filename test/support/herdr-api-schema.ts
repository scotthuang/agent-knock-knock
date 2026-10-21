/** Small synthetic declarations matching the documented 0.8/0.9.5 CLI shape. */
export function herdrApiSchemaFixture(protocol = 22) {
  return {
    schema_version: 1, protocol,
    schemas: {
      request: {
        type: "object", properties: { id: { type: "string" } }, required: ["id"],
        oneOf: ["pane.send_input", "pane.send_text"].map((method) => ({
          type: "object", required: ["method", "params"],
          properties: { method: { type: "string", const: method }, params: {
            type: "object", required: method === "pane.send_text" ? ["pane_id", "text"] : ["pane_id"],
            properties: { pane_id: { type: "string" }, text: { type: "string" },
              keys: { type: "array", items: { type: "string" } } }
          } }
        }))
      },
      success_response: {
        type: "object", required: ["id", "result"],
        properties: { id: { type: "string" }, result: { oneOf: [{
          type: "object", required: ["type"], properties: { type: { type: "string", const: "ok" } }
        }] } }
      },
      error_response: {
        type: "object", required: ["id", "error"],
        properties: { id: { type: "string" }, error: {
          type: "object", required: ["code", "message"],
          properties: { code: { type: "string" }, message: { type: "string" } }
        } }
      }
    }
  };
}

