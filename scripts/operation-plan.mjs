const hasText = (value) => typeof value === "string" && value.trim().length > 0;
const statuses = new Set(["pending", "completed", "skipped", "blocked", "uncertain"]);

export function structuredPlan(operation) {
	return operation?.planVersion === 2 ||
		(Array.isArray(operation?.plan) && operation.plan.some((step) => typeof step !== "string"));
}

export function assertOperationPlan(run) {
	const operation = run?.operation;
	const plan = operation?.plan;
	if (!Array.isArray(plan) || !plan.length) throw new Error("operation.plan must contain the PPT procedure.");
	if (operation.planVersion !== undefined && ![1, 2].includes(operation.planVersion)) {
		throw new Error("Unsupported operation.planVersion.");
	}
	if (!structuredPlan(operation)) {
		if (!plan.every(hasText)) throw new Error("Legacy plan contains an empty step.");
		return;
	}
	const ids = new Set();
	for (const step of plan) {
		if (!hasText(step?.id) || ids.has(step.id)) throw new Error("Every procedure step needs a unique id.");
		ids.add(step.id);
		const problem = (reason) => { throw new Error(`Step ${step.id}: ${reason}`); };
		if (!Number.isInteger(step.sourceSlide) || step.sourceSlide < 1 ||
			(Number.isInteger(run.sourcePptx?.slideCount) && step.sourceSlide > run.sourcePptx.slideCount)) {
			problem("sourceSlide must identify a slide in the input PPTX.");
		}
		if (!hasText(step.action) || !hasText(step.expectedResult)) problem("action and expectedResult are required.");
		if (!statuses.has(step.status)) problem("unknown or missing status.");
		if (step.required !== undefined && typeof step.required !== "boolean") problem("required must be boolean.");
		if (step.inputs !== undefined && (!Array.isArray(step.inputs) || !step.inputs.every(
			(input) => hasText(input?.field) && hasText(input.value) && ["required", "example"].includes(input.kind)
		))) problem("inputs must identify each field, value and its required/example role.");
	}
}
