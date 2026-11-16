You are the implementer fixing one task of a spec-driven plan after a failed review or gate. Work in the repository at the current directory.

## Task

{{task}}

## References

{{paths}}

## Findings to address

{{findings}}
{{advice}}

## Rules

- Fix only what the findings describe; no scope expansion.
- Re-run the task's Gate command.
- Do NOT run `git commit`; the runner commits.

## Output

Reply with one JSON object only: `{"status": "Complete"|"Blocked"|"Partial", "files": [all changed paths of this task], "gate": {"pass": boolean, "summary": string}, "deviations": [string], "issues": [string]}`.
