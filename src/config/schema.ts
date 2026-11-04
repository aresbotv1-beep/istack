import { z } from "zod";

export const PROFILES = ["solo", "team", "factory"] as const;

const check = z.strictObject({
  name: z.string().min(1),
  run: z.string().min(1),
});

const ownershipGate = z.strictObject({
  resource: z
    .string()
    .min(1)
    .describe("e.g. 'port 3200', 'shared local database', 'production deploy'"),
  owner: z.string().min(1),
  rule: z.string().min(1).describe("what an agent must do: usually 'ask the owner first'"),
});

const portName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "port names are lowercase words, e.g. web, api");
const port = z.number().int().min(1024, "pick ports above 1023").max(65535);

const envFile = z.strictObject({
  path: z.string().min(1).describe("relative to the checkout, e.g. .env.local"),
  set: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().min(1))
    .default({})
    .describe("KEY: port name or template, e.g. PORT: web, API_URL: 'http://127.0.0.1:{{api}}'"),
});

const DEFAULT_PORTS = { from: 4100, to: 4999, names: ["web"] };

export const envSchema = z
  .strictObject({
    ports: z
      .strictObject({
        from: port.default(4100),
        to: port.default(4999),
        names: z.array(portName).min(1).default(["web"]),
      })
      .default(DEFAULT_PORTS)
      .describe("each worktree leases one port per name from this range"),
    files: z
      .array(envFile)
      .default([])
      .describe("copied from the main checkout when absent, with port keys rewritten"),
    database: z
      .strictObject({
        name: z
          .string()
          .min(1)
          .default("{{repo}}_{{worktree}}")
          .describe("must include {{worktree}} so each worktree gets its own"),
        create: z.string().min(1).describe("shell command, e.g. 'createdb {{name}}'"),
        drop: z
          .string()
          .min(1)
          .optional()
          .describe("run on 'env down --db', e.g. 'dropdb {{name}}'"),
      })
      .optional(),
  })
  .default({ ports: DEFAULT_PORTS, files: [] });

export const DEFAULT_VISIBLE = [
  "**/*.{tsx,jsx,vue,svelte,astro,html,css,scss}",
  "**/templates/**",
  "public/**",
];

export const configSchema = z
  .strictObject({
    version: z.literal(1),
    owner: z.string().min(1).describe("the human who holds both gates"),
    profile: z.enum(PROFILES, { error: `profile must be one of: ${PROFILES.join(", ")}` }),
    checks: z.array(check).min(1, "list at least one check the repo must pass"),
    visibleChange: z
      .strictObject({
        include: z.array(z.string().min(1)).min(1).default(DEFAULT_VISIBLE),
        exclude: z.array(z.string().min(1)).default([]),
      })
      .default({ include: DEFAULT_VISIBLE, exclude: [] }),
    ownershipGates: z.array(ownershipGate).default([]),
    council: z
      .strictObject({
        enabled: z.boolean().default(false),
        budgetUsdPerPr: z.number().positive().default(10),
        providers: z.array(z.string().min(1)).default([]),
      })
      .default({ enabled: false, budgetUsdPerPr: 10, providers: [] }),
    env: envSchema,
  })
  .superRefine((config, ctx) => {
    if (config.council.enabled && config.profile === "solo") {
      ctx.addIssue({
        code: "custom",
        path: ["council", "enabled"],
        message: "council needs several providers; use profile 'team' or 'factory', or disable it",
      });
    }
    const { ports, files } = config.env;
    if (ports.to - ports.from + 1 < ports.names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["env", "ports", "to"],
        message: `the range ${ports.from}-${ports.to} cannot fit ${ports.names.length} ports`,
      });
    }
    files.forEach((file, index) => {
      for (const [key, value] of Object.entries(file.set)) {
        const used = ports.names.includes(value)
          ? []
          : [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string);
        const unknown = used.filter((name) => !ports.names.includes(name));
        if (unknown.length > 0 || (used.length === 0 && !ports.names.includes(value))) {
          ctx.addIssue({
            code: "custom",
            path: ["env", "files", index, "set", key],
            message: `use a port name (${ports.names.join(", ")}) or a template like "{{${ports.names[0]}}}"`,
          });
        }
      }
    });
  });

export type MitchstackConfig = z.output<typeof configSchema>;
export type EnvConfig = z.output<typeof envSchema>;
