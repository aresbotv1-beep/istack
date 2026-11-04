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

const DEFAULT_VISIBLE = [
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
  })
  .superRefine((config, ctx) => {
    if (config.council.enabled && config.profile === "solo") {
      ctx.addIssue({
        code: "custom",
        path: ["council", "enabled"],
        message: "council needs several providers; use profile 'team' or 'factory', or disable it",
      });
    }
  });

export type MitchstackConfig = z.output<typeof configSchema>;
