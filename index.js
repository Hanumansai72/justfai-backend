const { McpServer } = require("@modelcontextprotocol/server");
const { StdioServerTransport } = require("@modelcontextprotocol/server/stdio");
const { z } = require("zod");

const GEMINI_API_URL =
    process.env.GEMINI_API_URL ||
    "http://127.0.0.1:8081/v1/chat/completions";

const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY ||
    "sk-justride-2026";

const DEFAULT_MODEL =
    "gemini-3.5-flash-thinking@think=0";

const server = new McpServer({
    name: "local-gemini-coding",
    version: "1.0.0"
});

server.registerTool(
    "ask_gemini_coding",
    {
        title: "Ask Gemini Coding",
        description:
            "Ask the local Gemini API for coding, debugging, refactoring, architecture, code review, or programming help.",

        inputSchema: z.object({
            prompt: z
                .string()
                .min(1)
                .describe("The coding question or task."),

            model: z
                .string()
                .optional()
                .describe(
                    "Gemini model. Defaults to gemini-3.5-flash-thinking@think=0."
                )
        })
    },

    async ({ prompt, model }) => {
        const selectedModel = model || DEFAULT_MODEL;

        try {
            const response = await fetch(GEMINI_API_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${GEMINI_API_KEY}`
                },
                body: JSON.stringify({
                    model: selectedModel,
                    messages: [
                        {
                            role: "system",
                            content:
                                "You are an expert software engineer. " +
                                "Provide accurate, production-quality coding help. " +
                                "Analyze bugs carefully, explain root causes, " +
                                "and provide practical fixes."
                        },
                        {
                            role: "user",
                            content: prompt
                        }
                    ]
                })
            });

            const responseText = await response.text();

            if (!response.ok) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Gemini API error (${response.status}):\n${responseText}`
                        }
                    ],
                    isError: true
                };
            }

            let data;

            try {
                data = JSON.parse(responseText);
            } catch {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Gemini returned invalid JSON:\n${responseText}`
                        }
                    ],
                    isError: true
                };
            }

            const answer =
                data?.choices?.[0]?.message?.content ??
                data?.choices?.[0]?.text ??
                "Gemini returned no text.";

            return {
                content: [
                    {
                        type: "text",
                        text: answer
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Could not connect to gemini-web2api.\n\n` +
                            `URL: ${GEMINI_API_URL}\n` +
                            `Error: ${error.message}`
                    }
                ],
                isError: true
            };
        }
    }
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
});