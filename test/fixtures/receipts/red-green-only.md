## Summary

Save button restyled.

## Evidence

```receipts
{
  "version": 1,
  "head": "3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a",
  "door": {
    "kind": "two-way",
    "blastRadius": "the Save button on the settings page only"
  },
  "claims": [
    {
      "id": "C2",
      "kind": "red-green",
      "statement": "Save is disabled until the form is dirty",
      "command": "npx vitest run test/settings.test.tsx",
      "red": {
        "sha": "9e8d7c6",
        "exitCode": 1
      },
      "green": {
        "sha": "3f2a9c1",
        "exitCode": 0
      }
    }
  ]
}
```
