// Build patched/ from upstream/ (Audiom origin/master copies) with the CamioDotPad
// Run from this folder after export-upstream.sh; CAMIO below is this repo's camio-dotpad.
// integration edits. Every edit is anchored; a missing anchor aborts.
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const UP = path.join(ROOT, 'upstream');
const PA = path.join(ROOT, 'patched');
const CAMIO = path.resolve(__dirname, '../..');
fs.rmSync(PA, { recursive: true, force: true });

function edit(rel, edits) {
	let s = fs.readFileSync(path.join(UP, rel), 'utf8');
	for (const [anchor, replacement, where = 'after'] of edits) {
		const i = s.indexOf(anchor);
		if (i < 0) throw new Error(`${rel}: anchor not found: ${anchor.slice(0, 80)}`);
		if (s.indexOf(anchor, i + 1) >= 0 && where !== 'first') throw new Error(`${rel}: anchor not unique: ${anchor.slice(0, 80)}`);
		if (where === 'replace' || where === 'first') s = s.slice(0, i) + replacement + s.slice(i + anchor.length);
		else if (where === 'before') s = s.slice(0, i) + replacement + s.slice(i);
		else if (where === 'before-close') { const k = i + anchor.indexOf('		</section>'); s = s.slice(0, k) + replacement + s.slice(k); }
		else s = s.slice(0, i + anchor.length) + replacement + s.slice(i + anchor.length);
	}
	const out = path.join(PA, rel);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, s);
}

edit('src/modules/tactile/index.ts', [
	[
		`export { connectTactileMessageRow } from './connectTactileMessageRow';
`,
		`export {
	type CamioPointerStatus,
	createCamioPointer,
} from './camio/createCamioPointer';
`,
		'before',
	],
]);

edit('src/components/MapViewer/MapViewer.tsx', [
	[
		`import {
	connectTactileMessageRow,
	createDotPadController,`,
		`import {
	connectTactileMessageRow,
	createCamioPointer,
	createDotPadController,`,
		'replace',
	],
	[
		`	dotPadController: ReturnType<typeof createDotPadController> | null = null;
`,
		`	camioPointer: ReturnType<typeof createCamioPointer> | null = null;
`,
	],
	[
		`				} else if (this.demoSystem?.inputMethod === 'dotpad') {
					this.demoSystem.setInputMethod('keyboard');
				}
			},
		});
`,
		`		this.camioPointer = createCamioPointer({
			tactileTool: this.tactileTool,
			announce: (message) => this.speak(message),
			translate: (code, defaultValue) =>
				this.props.t(\`camio.prompt.\${code}\`, { defaultValue }),
			onStatusChange: (status) => mapState.setCamioPointerStatus(status),
		});
`,
	],
	[
		`			onConnectionChange: (connection) => {
				mapState.setDotPadConnection(connection);
`,
		`				// The camera pointer is only offered while a DOT Pad is connected.
				if (connection.state === 'disconnected') this.camioPointer?.stop();
`,
	],
	[
		`	private disposeTactile(): void {
`,
		`		this.camioPointer?.dispose();
		this.camioPointer = null;
`,
	],
	[
		`	public disconnectDotPad = (): void => {
		this.dotPadController?.disconnect();
	};
`,
		`
	public toggleCamioPointer = async (): Promise<void> => {
		if (this.rootStore.mapState.camioPointerStatus.phase === 'off') {
			await this.camioPointer?.start();
		} else this.camioPointer?.stop();
	};

	public registerCamioPointerByCorners = (): void => {
		this.camioPointer?.registerByCorners();
	};
`,
	],
]);

edit('src/stores/MapStateStore.ts', [
	[`import type { DotPadConnection } from '../modules/tactile';`, `import type {
	CamioPointerStatus,
	DotPadConnection,
} from '../modules/tactile';`, 'replace'],
	[`	dotPadConnection: DotPadConnection = { state: 'disconnected' };
`, `	camioPointerStatus: CamioPointerStatus = { phase: 'off' };
`],
	[`			dotPadConnection: observable.ref,
`, `			camioPointerStatus: observable.ref,
`],
	[`			setDotPadConnection: action,
`, `			setCamioPointerStatus: action,
`],
	[
		`	disconnectDotPad(): void {
		this.mapViewer.disconnectDotPad();
	}
`,
		`
	setCamioPointerStatus(status: CamioPointerStatus) {
		this.camioPointerStatus = status;
	}

	toggleCamioPointer(): Promise<void> {
		return this.mapViewer.toggleCamioPointer();
	}

	registerCamioPointerByCorners(): void {
		this.mapViewer.registerCamioPointerByCorners();
	}
`,
	],
]);

edit('src/components/MapMenu/DotPadControls.tsx', [
	[
		`export interface DotPadControlsProps {`,
		`/** The camera fingertip pointer, offered while a DOT Pad is connected. */
export interface CameraPointerControl {
	on: boolean;
	label: string;
	registerLabel: string;
	statusLabel: string;
	onToggle(): Promise<void>;
	onRegister(): void;
}

`,
		'before',
	],
	[
		`	/** Called on mount to warm the lazily loaded DOT Pad support. */
	onPreload(): void;
`,
		`	cameraPointer?: CameraPointerControl;
`,
	],
	[`	onPreload,
}: DotPadControlsProps) {`, `	onPreload,
	cameraPointer,
}: DotPadControlsProps) {`, 'replace'],
	[
		`			)}
		</section>`,
		`			{connected && cameraPointer ? (
				<>
					<button
						type="button"
						className={\`\${styles.optionItem} \${styles.deviceAction}\`}
						role="menuitemcheckbox"
						aria-checked={cameraPointer.on}
						onKeyDown={handleHardwareActionKeyDown}
						onClick={() => {
							cameraPointer.onToggle().catch(reportActionError);
						}}
					>
						{cameraPointer.label}
					</button>
					{cameraPointer.on ? (
						<button
							type="button"
							className={\`\${styles.optionItem} \${styles.deviceAction}\`}
							role="menuitem"
							onKeyDown={handleHardwareActionKeyDown}
							onClick={cameraPointer.onRegister}
						>
							{cameraPointer.registerLabel}
						</button>
					) : null}
					<p className={styles.deviceStatus} role="status" aria-live="polite">
						{cameraPointer.statusLabel}
					</p>
				</>
			) : null}
`,
		'before-close',
	],
]);
edit('src/components/MapMenu/DisplayOptionsMenu.tsx', [
	[
		`		const preloadDotPad = useCallback(() => mapState.preloadDotPad(), [mapState]);
`,
		`		const camioStatus = mapState.camioPointerStatus;
		const cameraPointer = {
			on: camioStatus.phase !== 'off',
			label: t('mainMenu.displayOptions.dotPad.cameraPointer'),
			registerLabel: t('mainMenu.displayOptions.dotPad.cameraPointerRegister'),
			statusLabel: t(
				\`camio.status.\${'tracking' in camioStatus && camioStatus.phase === 'ready' ? camioStatus.tracking : camioStatus.phase}\`,
			),
			onToggle: () => mapState.toggleCamioPointer(),
			onRegister: () => mapState.registerCamioPointerByCorners(),
		};
`,
	],
	[`							onPreload={preloadDotPad}
`, `							cameraPointer={cameraPointer}
`],
]);

// en translations: two control labels + the camio.prompt.* / camio.status.* namespaces.
{
	const PROMPTS = {
		'register.handsOff': 'Take your hands off the DOT Pad.',
		'register.searching': 'Looking for the DOT Pad pins.',
		'register.corner.topLeft': 'Point at the top-left corner pin of the DOT Pad and hold.',
		'register.corner.topRight': 'Point at the top-right corner pin and hold.',
		'register.corner.bottomRight': 'Point at the bottom-right corner pin and hold.',
		'register.corner.bottomLeft': 'Point at the bottom-left corner pin and hold.',
		'register.cornersRejected': "Those corners don't look like the pin area. Let's try again.",
		'register.liftHand': 'Got it. Lift your hand for a moment.',
		'register.confirmTopLeft': 'Found the DOT Pad. Touch the top-left pin and hold.',
		'register.confirmMissed': "That wasn't near a corner pin. Let's register by the corners instead.",
		'register.notFound': "I couldn't find the DOT Pad. Try registering it by its corners.",
		'register.done': 'DOT Pad registered. Point at the pins.',
		'register.cancelled': 'Registration cancelled.',
		'pointing.oneHand': 'Point with only one hand.',
		'tracking.lost': 'Lost track of the DOT Pad. Take your hands off it for a moment.',
		'tracking.restored': 'Found the DOT Pad again.',
		'tracking.moved': 'The DOT Pad moved. Re-registered.',
		'tracking.pinsNotVisible': "I can't see the pins, so moving the DOT Pad won't be noticed until they are visible.",
		'camera.noFrames': 'The camera opened but sent no pictures. Close other apps using it and try again.',
		'camera.denied': 'Camera access was blocked. Allow the camera for this page to use the pointer.',
	};
	// Keep in sync with src/prompts.ts (asserted by camio-dotpad/test/prompts.test.ts).
	const lib = fs.readFileSync(path.join(CAMIO, 'src/prompts.ts'), 'utf8');
	for (const [k, v] of Object.entries(PROMPTS)) if (!lib.includes(JSON.stringify(v).slice(1, -1)) && !lib.includes(v)) throw new Error(`prompt text drift: ${k}`);
	const nested = {};
	for (const [k, v] of Object.entries(PROMPTS)) {
		const parts = k.split('.');
		let o = nested;
		for (const p of parts.slice(0, -1)) o = o[p] ??= {};
		o[parts.at(-1)] = v;
	}
	const STATUS = {
		off: 'Camera pointer off.',
		starting: 'Starting the camera.',
		idle: 'Camera on. The DOT Pad is not registered.',
		corners: 'Registering the corners.',
		autoFind: 'Looking for the DOT Pad.',
		confirm: 'Touch the top-left pin to confirm.',
		handsOff: 'Lift your hand.',
		none: 'Camera on.',
		tracking: 'Following the DOT Pad.',
		occluded: 'Following the DOT Pad (partly covered).',
		static: 'Pins not visible; not following the DOT Pad.',
		lost: 'Lost the DOT Pad.',
		fixed: 'Position fixed.',
	};
	const indent = (json, tabs) => json.split('\n').map((l, i) => (i ? '\t'.repeat(tabs) + l : l)).join('\n');
	const camio = indent(JSON.stringify({ prompt: nested, status: STATUS }, null, '\t'), 1);
	edit('public/locales/en/translation.json', [
		[
			`				"genOneUpdate": "Lift your hands while the DOT Pad updates."
`,
			`				"genOneUpdate": "Lift your hands while the DOT Pad updates.",
				"cameraPointer": "Camera pointer",
				"cameraPointerRegister": "Register DOT Pad by its corners"
`,
			'replace',
		],
	]);
	const rel = 'public/locales/en/translation.json';
	let s = fs.readFileSync(path.join(PA, rel), 'utf8');
	const last = s.lastIndexOf('}');
	const prevClose = s.lastIndexOf('}', last - 1);
	s = `${s.slice(0, prevClose + 1)},\n\t"camio": ${camio}\n}\n`;
	fs.writeFileSync(path.join(PA, rel), s);
	JSON.parse(s);
}

edit('src/lib/build-embed-string.ts', [
	[`style="border: 0" allowfullscreen></iframe>`, `style="border: 0" allow="camera; fullscreen" allowfullscreen></iframe>`, 'replace'],
]);

edit('documentation/embedding.md', [
	[
		`Without iframe fullscreen permission, users hear "Fullscreen is not available"
when they try to enter fullscreen mode.
`,
		`
The DOT Pad camera pointer needs the camera inside the iframe, so the generated
snippet also carries \`allow="camera; fullscreen"\`. Without \`camera\` the browser
refuses the camera and Audiom says so; everything else keeps working. Video is
processed on the device and never leaves the browser.
`,
	],
]);

// New files.
for (const [from, to] of [
	['audiom/createCamioPointer.ts', 'src/modules/tactile/camio/createCamioPointer.ts'],
	['audiom/createCamioPointer.test.ts', 'src/modules/tactile/camio/createCamioPointer.test.ts'],
]) {
	const out = path.join(PA, to);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.copyFileSync(path.join(CAMIO, from), out);
}
console.log('patched/ written');
