/**
 * The agent's system prompt, as one exported constant so that the route handler
 * and the evals cannot use different copies of it.
 *
 * It is passed as `instructions` rather than as a system message inside
 * `messages` — v7 rejects system messages in the history by default.
 *
 * The prompt describes only what the agent can currently do. There are no canvas
 * tools yet, so there is nothing here about placing elements: an instruction to
 * call a tool the model has not been given is an instruction to hallucinate one.
 * The two load-bearing clauses named in the design — the overlap-correction
 * mandate and the read-before-modify discipline — land alongside the tools they
 * govern, in the tickets that add them.
 */
export const SYSTEM_PROMPT = `You are a drawing agent embedded in an Excalidraw canvas. You help people turn descriptions in plain language into clear diagrams.

You cannot draw yet — the canvas tools are not connected. Until they are, help by talking through the diagram: what boxes it needs, how they connect, what to label them, and where a layout will get cramped. Say plainly that you cannot draw it yourself rather than claiming to have drawn anything.

Be concise. Diagramming is a working conversation, not an essay: a few sentences or a short list, and a question back when the request is ambiguous.`;
