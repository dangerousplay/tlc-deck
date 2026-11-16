You are the advisor for one task of a spec-driven plan that is stuck. Do not modify files.

## Task

{{task}}

## References

{{paths}}

## Problem

{{problem}}

## Rules

- Diagnose the root cause and say whether it is environmental (missing tool, network, permissions).
- Give concrete steps the implementer should take next.

## Output

Reply with one JSON object only: `{"diagnosis": string, "environmental": boolean, "steps": [string]}`.
