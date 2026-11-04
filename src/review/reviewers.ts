/** The label a reviewer carries when it shares the builder's provider. Shown in the PR body. */
export const SAME_PROVIDER_LABEL = "same-provider reviewer (no second provider available)";

export type ReviewerVia =
  | "delegate_task"
  | "codex exec"
  | "claude -p"
  | "cursor-agent"
  | "fresh-context subagent";

export interface ReviewerChoice {
  kind: "cross-provider" | "same-provider";
  via: ReviewerVia;
  /** Lower-case provider name, e.g. "openai". */
  provider: string;
  /** The command prefix to run; the caller appends the prompt. Absent for harness tools. */
  argv?: string[];
  label: string;
}

export interface ReviewerProbe {
  /** Whether a command is on PATH. Probing must not run the command. */
  hasCommand: (name: string) => boolean;
  /** Providers the harness's delegate_task tool can reach, when the harness reports one. */
  delegateTaskProviders?: string[];
}

interface Cli {
  via: Exclude<ReviewerVia, "delegate_task" | "fresh-context subagent">;
  command: string;
  provider: string;
  argv: string[];
}

/** In preference order. cursor-agent counts as its own provider. */
const CLIS: Cli[] = [
  { via: "codex exec", command: "codex", provider: "openai", argv: ["codex", "exec"] },
  { via: "claude -p", command: "claude", provider: "anthropic", argv: ["claude", "-p"] },
  {
    via: "cursor-agent",
    command: "cursor-agent",
    provider: "cursor",
    argv: ["cursor-agent", "-p"],
  },
];

/**
 * Pick one reviewer from a different provider than the builder: the harness's delegate_task
 * first, then codex exec, claude -p, cursor-agent. With no second provider, fall back to a
 * fresh-context reviewer from the builder's own provider, labelled so. Pure; runs nothing.
 */
export function chooseReviewer(input: {
  builderProvider: string;
  probe: ReviewerProbe;
}): ReviewerChoice {
  const builder = input.builderProvider.toLowerCase();
  const delegated = (input.probe.delegateTaskProviders ?? []).map((p) => p.toLowerCase());
  const other = delegated.find((p) => p !== builder);
  if (other) {
    return {
      kind: "cross-provider",
      via: "delegate_task",
      provider: other,
      label: `delegate_task (${other})`,
    };
  }
  const present = CLIS.filter((cli) => input.probe.hasCommand(cli.command));
  const cross = present.find((cli) => cli.provider !== builder);
  if (cross) {
    return {
      kind: "cross-provider",
      via: cross.via,
      provider: cross.provider,
      argv: [...cross.argv],
      label: `${cross.via} (${cross.provider})`,
    };
  }
  if (delegated.includes(builder)) {
    return {
      kind: "same-provider",
      via: "delegate_task",
      provider: builder,
      label: SAME_PROVIDER_LABEL,
    };
  }
  const own = present.find((cli) => cli.provider === builder);
  if (own) {
    return {
      kind: "same-provider",
      via: own.via,
      provider: builder,
      argv: [...own.argv],
      label: SAME_PROVIDER_LABEL,
    };
  }
  return {
    kind: "same-provider",
    via: "fresh-context subagent",
    provider: builder,
    label: SAME_PROVIDER_LABEL,
  };
}
