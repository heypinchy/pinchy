import { TOOL_CAPABLE_OLLAMA_CLOUD_MODELS } from "@/lib/ollama-cloud-models";

it("every model declares all capability fields", () => {
  for (const m of TOOL_CAPABLE_OLLAMA_CLOUD_MODELS) {
    expect(typeof m.vision).toBe("boolean");
    expect(m.documents).toBe(false);
    expect(m.audio).toBe(false);
    expect(m.video).toBe(false);
  }
});
