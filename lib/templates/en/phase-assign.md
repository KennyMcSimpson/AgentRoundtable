Turn task (assign): draft the task list. Write one line per executor seat: `- <seatId>: <task> | acceptance: ["node","--test","x.test.mjs"]`, save it to a file and run  {{roomCmd}} assign --seat {{seatDir}} --attempt {{attemptId}} --file <draft>.
Do not edit project files yourself. If the draft fails parsing it falls back to manual user input; work begins only after user confirmation.
