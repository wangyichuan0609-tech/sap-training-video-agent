export type SapPageSelector =
	| { by: "id"; value: string }
	| { by: "css"; value: string }
	| { by: "exactText"; value: string }
	| { by: "visibleText"; value: string };

export type SapPageAction =
	| { kind: "state" }
	| { kind: "probe" | "target"; selector: SapPageSelector }
	| { kind: "find" | "click"; selector: SapPageSelector }
	| { kind: "press"; selector: SapPageSelector }
	| { kind: "wait"; selector: SapPageSelector; timeoutMs: number }
	| { kind: "login"; user: string; password: string }
	| {
			kind: "change-password";
			user: string;
			currentPassword: string;
			newPassword: string;
	  };

export interface SapPageActionResult {
	targetName: string;
	controlType: string;
	domRect: { x: number; y: number; width: number; height: number };
	url: string;
	title: string;
	visibleResult: string;
	redacted: boolean;
	captureReady?: boolean;
	sapClient?: string;
	controls?: SapPageControlSummary[];
}

export interface SapPageControlSummary {
	id?: string;
	name?: string;
	tagName: string;
	role?: string;
	controlType: string;
	targetName: string;
	ariaLabel?: string;
	title?: string;
	placeholder?: string;
	text?: string;
}

export interface SapPageProbeResult {
	matchCount: number;
}

async function executeSapPageAction(
	action: SapPageAction,
): Promise<SapPageActionResult | SapPageProbeResult | HTMLElement> {
	const normalizeText = (value: string | null | undefined): string =>
		String(value ?? "")
			.replace(/\s+/g, " ")
			.trim();
	const redact = (value: string, secrets: readonly string[]): string => {
		let result = value;
		for (const secret of secrets) {
			if (secret) result = result.split(secret).join("[REDACTED]");
		}
		return result;
	};
	const visibleSummary = (secrets: readonly string[] = []): string => {
		const text = normalizeText(document.body?.innerText ?? "");
		return redact(text, secrets).slice(0, 800);
	};
	const isVisible = (element: Element): boolean => {
		const style = window.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return (
			!element.hasAttribute("hidden") &&
			element.getAttribute("aria-hidden") !== "true" &&
			style.display !== "none" &&
			style.visibility !== "hidden" &&
			Number(style.opacity || "1") !== 0 &&
			rect.width > 0 &&
			rect.height > 0
		);
	};
	const isDisabled = (element: Element): boolean => {
		const candidate = element as Element & { disabled?: boolean };
		return candidate.disabled === true || element.getAttribute("aria-disabled") === "true";
	};
	const exactTextCandidates = (value: string): Element[] => {
		const selectors = [
			"button",
			"a",
			"label",
			"[role='button']",
			"[role='tab']",
			"[role='option']",
			"[role='menuitem']",
			"[tabindex]",
			"ui5-button",
			"ui5-tab",
		].join(",");
		return [...document.querySelectorAll(selectors)].filter(
			(element) => normalizeText((element as HTMLElement).innerText) === value,
		);
	};
	const visibleTextCandidates = (value: string): HTMLElement[] => {
		const selectors = [
			"[data-sap-ui]",
			"[role='option']",
			"[role='menuitem']",
			"[role='button']",
			"button",
			"a",
			"li",
			"[tabindex]",
		].join(",");
		const candidates = [...document.querySelectorAll(selectors)].filter(
			(element): element is HTMLElement =>
				element instanceof HTMLElement &&
				isVisible(element) &&
				normalizeText(element.innerText) === value,
		);
		const hitTestVisible = (element: HTMLElement): boolean => {
			const rect = element.getBoundingClientRect();
			const x = Math.min(
				Math.max(rect.left + rect.width / 2, 0),
				Math.max(window.innerWidth - 1, 0),
			);
			const y = Math.min(
				Math.max(rect.top + rect.height / 2, 0),
				Math.max(window.innerHeight - 1, 0),
			);
			const hit = document.elementFromPoint(x, y);
			return Boolean(hit && (hit === element || element.contains(hit)));
		};
		const hitCandidates = candidates.filter(hitTestVisible);
		const leafCandidates = hitCandidates.filter(
			(element) =>
				!hitCandidates.some((other) => other !== element && element.contains(other)),
		);
		return leafCandidates.length > 0 ? leafCandidates : hitCandidates;
	};
	const matchingTargets = (selector: SapPageSelector): Element[] => {
		let matches: Element[];
		if (selector.by === "id") {
			const match = document.getElementById(selector.value);
			matches = match ? [match] : [];
		} else if (selector.by === "css") {
			matches = [...document.querySelectorAll(selector.value)];
		} else if (selector.by === "exactText") {
			matches = exactTextCandidates(normalizeText(selector.value));
		} else {
			matches = visibleTextCandidates(normalizeText(selector.value));
		}
		return matches;
	};
	const resolveTarget = (selector: SapPageSelector): HTMLElement => {
		const matches = matchingTargets(selector);

		if (matches.length !== 1) {
			throw new Error(`Target matched ${matches.length} elements; exactly one is required.`);
		}
		const target = matches[0];
		if (!(target instanceof HTMLElement)) {
			throw new Error("Target is not an HTML control.");
		}
		if (!isVisible(target)) {
			throw new Error("Target is hidden.");
		}
		if (isDisabled(target)) {
			throw new Error("Target is disabled.");
		}
		return target;
	};
	const targetName = (element: HTMLElement): string => {
		const labelledBy = element.getAttribute("aria-labelledby");
		const labelledText = labelledBy
			? labelledBy
					.split(/\s+/)
					.map((id) => normalizeText(document.getElementById(id)?.textContent))
					.filter(Boolean)
					.join(" ")
			: "";
		const explicitLabel =
			element.id && typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? normalizeText(
						document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
							?.textContent,
					)
				: "";
		return (
			normalizeText(element.getAttribute("aria-label")) ||
			labelledText ||
			explicitLabel ||
			normalizeText(element.getAttribute("title")) ||
			normalizeText(element.getAttribute("placeholder")) ||
			normalizeText(element.innerText) ||
			element.id ||
			element.tagName.toLowerCase()
		);
	};
	const controlType = (element: HTMLElement): string => {
		const role = normalizeText(element.getAttribute("role"));
		if (role) return role;
		if (element instanceof HTMLInputElement) return `input:${element.type || "text"}`;
		return element.tagName.toLowerCase();
	};
	const isSensitiveControl = (element: HTMLElement): boolean => {
		if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
			return true;
		}
		const autocomplete = normalizeText(element.getAttribute("autocomplete")).toLowerCase();
		if (autocomplete.includes("password") || autocomplete.includes("one-time-code")) {
			return true;
		}
		const identity = [
			element.id,
			element.getAttribute("name"),
			element.getAttribute("aria-label"),
			element.getAttribute("placeholder"),
		]
			.map((value) => normalizeText(value).toLowerCase())
			.join(" ");
		return /(?:password|passwd|passcode|secret|token|credential|otp|one[ -]?time)/u.test(
			identity,
		);
	};
	const controlSummaries = (): SapPageControlSummary[] => {
		const selector = [
			"input",
			"textarea",
			"select",
			"button",
			"a",
			"[role='button']",
			"[role='combobox']",
			"[role='tab']",
			"[role='menuitem']",
			"[role='option']",
			"[tabindex]",
		].join(",");
		const elements = [...new Set(document.querySelectorAll<HTMLElement>(selector))];
		return elements
			.filter((element) => isVisible(element) && !isSensitiveControl(element))
			.slice(0, 160)
			.map((element) => {
				const optional = (value: string | null | undefined, maximumLength: number) => {
					const normalized = normalizeText(value).slice(0, maximumLength);
					return normalized || undefined;
				};
				return {
					...(optional(element.id, 240) ? { id: optional(element.id, 240) } : {}),
					...(optional(element.getAttribute("name"), 240)
						? { name: optional(element.getAttribute("name"), 240) }
						: {}),
					tagName: element.tagName.toLowerCase(),
					...(optional(element.getAttribute("role"), 80)
						? { role: optional(element.getAttribute("role"), 80) }
						: {}),
					controlType: controlType(element),
					targetName: targetName(element).slice(0, 300),
					...(optional(element.getAttribute("aria-label"), 300)
						? { ariaLabel: optional(element.getAttribute("aria-label"), 300) }
						: {}),
					...(optional(element.getAttribute("title"), 300)
						? { title: optional(element.getAttribute("title"), 300) }
						: {}),
					...(optional(element.getAttribute("placeholder"), 300)
						? { placeholder: optional(element.getAttribute("placeholder"), 300) }
						: {}),
					...(optional(element.innerText, 300)
						? { text: optional(element.innerText, 300) }
						: {}),
				};
			});
	};
	const rectFor = (element: HTMLElement | null) => {
		if (!element) {
			return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
		}
		const rect = element.getBoundingClientRect();
		return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	};
	const resultFor = (
		element: HTMLElement | null,
		secrets: readonly string[] = [],
		redacted = false,
	): SapPageActionResult => ({
		targetName: element ? targetName(element) : "SAP Page",
		controlType: element ? controlType(element) : "document",
		domRect: rectFor(element),
		url: location.href,
		title: document.title,
		visibleResult: visibleSummary(secrets),
		redacted,
		...(!element ? { controls: controlSummaries() } : {}),
	});
	const pause = (durationMs: number): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, durationMs));
	const typeControlValue = async (
		element: HTMLInputElement | HTMLTextAreaElement,
		value: string,
	): Promise<void> => {
		const prototype =
			element instanceof HTMLInputElement
				? HTMLInputElement.prototype
				: HTMLTextAreaElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
		if (!setter) throw new Error("Target does not expose a writable value.");
		element.focus();
		setter.call(element, "");
		element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
		let typed = "";
		for (const character of value) {
			typed += character;
			setter.call(element, typed);
			element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
			await pause(85);
		}
		element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
	};
	const waitForTarget = async (
		selector: SapPageSelector,
		timeoutMs: number,
	): Promise<HTMLElement> => {
		const deadline = Date.now() + timeoutMs;
		let lastError: unknown = new Error("Target was not found.");
		while (Date.now() <= deadline) {
			try {
				return resolveTarget(selector);
			} catch (error) {
				lastError = error;
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw lastError;
	};

	if (action.kind === "state") {
		const loginOrBusy = [...document.querySelectorAll<HTMLElement>(
			"input, #LOGIN_LINK, [aria-busy='true'], .sapUiLocalBusyIndicator, #sapUiBusyIndicator, iframe[title*='captcha' i]",
		)].some((element) => isVisible(element) && (
			!(element instanceof HTMLInputElement) || isSensitiveControl(element) ||
			element.id === "USERNAME_FIELD-inner" || element.autocomplete === "username"
		));
		const clients = new URLSearchParams(location.search).getAll("sap-client");
		const metaClient = document.querySelector<HTMLMetaElement>("meta[name='sap-client' i]")?.content;
		if (metaClient) clients.push(metaClient);
		const sapClient = clients[0];
		const clientConsistent = clients.every((client) => /^\d{3}$/u.test(client) && client === sapClient);
		return {
			...resultFor(null),
			captureReady: document.readyState === "complete" && !loginOrBusy && clientConsistent,
			...(sapClient && clientConsistent ? { sapClient } : {}),
		};
	}
	if (action.kind === "probe") {
		return { matchCount: matchingTargets(action.selector).length };
	}
	if (action.kind === "target") {
		return resolveTarget(action.selector);
	}
	if (action.kind === "login") {
		const username = resolveTarget({ by: "id", value: "USERNAME_FIELD-inner" });
		const password = resolveTarget({ by: "id", value: "PASSWORD_FIELD-inner" });
		const language = resolveTarget({ by: "id", value: "LANGUAGE_SELECT" });
		const login = resolveTarget({ by: "id", value: "LOGIN_LINK" });
		if (!(language instanceof HTMLSelectElement)) {
			throw new Error("LANGUAGE_SELECT is not a select control.");
		}
		if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement)) {
			throw new Error("SAP login fields are not input controls.");
		}
		username.focus();
		await pause(450);
		await typeControlValue(username, action.user);
		await pause(650);
		password.focus();
		await pause(400);
		await typeControlValue(password, action.password);
		await pause(700);
		if (
			language.value !== "EN" &&
			[...language.options].some((option) => option.value === "EN")
		) {
			language.value = "EN";
			language.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
			await pause(350);
		}
		login.focus();
		await pause(350);
		login.click();
		return resultFor(login, [action.user, action.password], true);
	}
	if (action.kind === "change-password") {
		const visibleSensitiveInputs = (): HTMLInputElement[] =>
			[...document.querySelectorAll("input")].filter(
				(element): element is HTMLInputElement =>
					element instanceof HTMLInputElement &&
					isVisible(element) &&
					isSensitiveControl(element),
			);
		const changePasswordControls = (): HTMLElement[] => {
			const candidates = document.querySelectorAll<HTMLElement>(
				"button, input[type='button'], input[type='submit'], a, [role='button']",
			);
			return [...candidates].filter((element) => {
				if (!isVisible(element)) return false;
				const labels = [
					targetName(element),
					element.innerText,
					element instanceof HTMLInputElement ? element.value : "",
					element.getAttribute("aria-label"),
					element.getAttribute("title"),
				].map((value) => normalizeText(value).toLowerCase());
				return labels.includes("change password");
			});
		};
		const visibleUsernameInputs = (): HTMLInputElement[] =>
			[...document.querySelectorAll("input[id='USERNAME_FIELD-inner']")].filter(
				(element): element is HTMLInputElement =>
					element instanceof HTMLInputElement &&
					isVisible(element) &&
					!isSensitiveControl(element),
			);

		let sensitiveInputs = visibleSensitiveInputs();
		let controls = changePasswordControls();
		if (sensitiveInputs.length > 3) {
			throw new Error(
				`Change Password page matched ${sensitiveInputs.length} visible sensitive inputs; exactly three are required.`,
			);
		}
		if (controls.length !== 1) {
			throw new Error(
				`Change Password page matched ${controls.length} visible Change Password controls; exactly one is required.`,
			);
		}
		if (isDisabled(controls[0])) {
			throw new Error("The Change Password control is disabled.");
		}
		if (sensitiveInputs.length !== 3) {
			if (sensitiveInputs.length !== 1) {
				throw new Error(
					`SAP logon page matched ${sensitiveInputs.length} visible sensitive inputs; exactly one is required before Change Password.`,
				);
			}
			if (isDisabled(sensitiveInputs[0])) {
				throw new Error("The SAP logon password input is disabled.");
			}
			const usernameInputs = visibleUsernameInputs();
			if (usernameInputs.length !== 1) {
				throw new Error(
					`SAP logon page matched ${usernameInputs.length} visible username inputs; exactly one is required.`,
				);
			}
			if (isDisabled(usernameInputs[0])) {
				throw new Error("The SAP logon username input is disabled.");
			}

			await typeControlValue(usernameInputs[0], action.user);
			await pause(350);
			await typeControlValue(sensitiveInputs[0], action.currentPassword);
			await pause(350);
			const currentUsernameInputs = visibleUsernameInputs();
			const currentLoginSensitiveInputs = visibleSensitiveInputs();
			const currentPreStepControls = changePasswordControls();
			if (
				currentUsernameInputs.length !== 1 ||
				currentUsernameInputs[0] !== usernameInputs[0] ||
				currentLoginSensitiveInputs.length !== 1 ||
				currentLoginSensitiveInputs[0] !== sensitiveInputs[0] ||
				currentPreStepControls.length !== 1 ||
				currentPreStepControls[0] !== controls[0]
			) {
				throw new Error(
					"The SAP logon Change Password controls changed before submission.",
				);
			}
			if (
				currentUsernameInputs[0].value !== action.user ||
				currentLoginSensitiveInputs[0].value !== action.currentPassword
			) {
				throw new Error(
					"The SAP logon credential inputs did not retain the requested values.",
				);
			}
			if (isDisabled(currentPreStepControls[0])) {
				throw new Error("The SAP logon Change Password control became disabled.");
			}

			currentPreStepControls[0].focus();
			currentPreStepControls[0].click();
			const deadline = Date.now() + 5_000;
			while (Date.now() <= deadline) {
				await pause(50);
				sensitiveInputs = visibleSensitiveInputs();
				controls = changePasswordControls();
				if (sensitiveInputs.length > 3) {
					throw new Error(
						`Change Password page matched ${sensitiveInputs.length} visible sensitive inputs; exactly three are required.`,
					);
				}
				if (controls.length > 1) {
					throw new Error(
						`Change Password page matched ${controls.length} visible Change Password controls; exactly one is required.`,
					);
				}
				if (sensitiveInputs.length === 3 && controls.length === 1) break;
			}
			if (sensitiveInputs.length !== 3 || controls.length !== 1) {
				throw new Error(
					"The Change Password form did not become uniquely available within 5000 ms.",
				);
			}
		}
		if (sensitiveInputs.some((element) => isDisabled(element))) {
			throw new Error("A required Change Password input is disabled.");
		}
		if (isDisabled(controls[0])) {
			throw new Error("The Change Password control is disabled.");
		}

		await typeControlValue(sensitiveInputs[0], action.currentPassword);
		await pause(300);
		await typeControlValue(sensitiveInputs[1], action.newPassword);
		await pause(300);
		await typeControlValue(sensitiveInputs[2], action.newPassword);
		await pause(350);

		const currentInputs = [...document.querySelectorAll("input")].filter(
			(element): element is HTMLInputElement =>
				element instanceof HTMLInputElement &&
				isVisible(element) &&
				isSensitiveControl(element),
		);
		const currentControls = changePasswordControls();
		if (
			currentInputs.length !== 3 ||
			currentInputs.some((element, index) => element !== sensitiveInputs[index]) ||
			currentControls.length !== 1 ||
			currentControls[0] !== controls[0]
		) {
			throw new Error("The Change Password controls changed before submission.");
		}
		if (
			currentInputs[0].value !== action.currentPassword ||
			currentInputs[1].value !== action.newPassword ||
			currentInputs[2].value !== action.newPassword
		) {
			throw new Error("The Change Password inputs did not retain the requested values.");
		}
		if (isDisabled(currentControls[0])) {
			throw new Error("The Change Password control became disabled before submission.");
		}

		currentControls[0].focus();
		currentControls[0].click();
		return resultFor(
			currentControls[0],
			[action.user, action.currentPassword, action.newPassword],
			true,
		);
	}

	const target =
		action.kind === "wait"
			? await waitForTarget(action.selector, action.timeoutMs)
			: resolveTarget(action.selector);
	if (action.kind === "press") {
		target.focus();
		if (document.activeElement !== target && !target.contains(document.activeElement)) {
			throw new Error("Target did not retain DOM focus.");
		}
	}
	if (action.kind === "click") {
		target.click();
	}
	return resultFor(target);
}

export function buildSapPageActionScript(action: SapPageAction): string {
	return `(${executeSapPageAction.toString()})(${JSON.stringify(action)})`;
}
