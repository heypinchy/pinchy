import Link from "next/link";
import { getAgentAvatarSvg } from "@/lib/avatar";

export interface Agent {
  id: string;
  name: string;
  model: string;
  isPersonal: boolean;
  tagline: string | null;
  avatarSeed: string | null;
}

interface AgentListProps {
  agents: Agent[];
  currentPath: string;
  onAgentClick?: () => void;
}

export function sortAgents(agents: Agent[]): Agent[] {
  return [...agents].sort((a, b) => {
    if (a.isPersonal && !b.isPersonal) return -1;
    if (!a.isPersonal && b.isPersonal) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function AgentList({ agents, currentPath, onAgentClick }: AgentListProps) {
  const sortedAgents = sortAgents(agents);

  return (
    <ul className="flex flex-col gap-1">
      {sortedAgents.map((agent) => {
        const isActive = currentPath.startsWith(`/chat/${agent.id}`);
        return (
          <li key={agent.id}>
            <Link
              href={`/chat/${agent.id}`}
              onClick={onAgentClick}
              data-active={isActive ? "true" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 transition-colors ${
                isActive
                  ? "bg-[oklch(0.92_0.005_60)] text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={getAgentAvatarSvg({
                  avatarSeed: agent.avatarSeed,
                  name: agent.name,
                })}
                alt=""
                className="size-8 rounded-full shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="truncate font-semibold" title={agent.name}>
                  {agent.name}
                </span>
                {agent.tagline && (
                  <span
                    className={`text-xs truncate ${isActive ? "text-muted-foreground" : "text-muted-foreground/70"}`}
                    title={agent.tagline}
                  >
                    {agent.tagline}
                  </span>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
