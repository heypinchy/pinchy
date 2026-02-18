"use client";

import { useState } from "react";
import { useChat } from "@/hooks/use-chat";

interface ChatProps {
  agentId: string;
  agentName: string;
}

export function Chat({ agentId, agentName }: ChatProps) {
  const { messages, sendMessage, isConnected } = useChat(agentId);
  const [input, setInput] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;
    sendMessage(input.trim());
    setInput("");
  }

  return (
    <div className="flex flex-col h-full">
      <header className="p-4 border-b">
        <h1 className="font-bold">{agentName}</h1>
        <span
          className={`text-xs ${isConnected ? "text-green-600" : "text-red-600"}`}
        >
          {isConnected ? "Verbunden" : "Getrennt"}
        </span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`p-3 rounded-lg max-w-[80%] ${
              msg.role === "user"
                ? "ml-auto bg-black text-white"
                : "bg-gray-100"
            }`}
          >
            {msg.content}
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Nachricht an ${agentName}...`}
          className="flex-1 rounded border p-2"
        />
        <button
          type="submit"
          className="rounded bg-black text-white px-4 py-2 hover:bg-gray-800"
        >
          Senden
        </button>
      </form>
    </div>
  );
}
