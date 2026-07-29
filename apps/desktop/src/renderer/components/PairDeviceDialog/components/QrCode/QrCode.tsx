import { useMemo } from "react";
import { encodeQrMatrix } from "../../utils/encodeQrMatrix";

interface QrCodeProps {
	/**
	 * The value to encode. For pairing this is the URI whose FRAGMENT holds the
	 * pairing code, so it is passed straight to the encoder and never rendered
	 * as text, put in the DOM as an attribute, or handed to anything else.
	 */
	value: string;
	/** Describes the QR for assistive tech. MUST NOT include `value`. */
	label: string;
	className?: string;
}

/** Modules of white margin. Four is the spec's minimum for a reliable scan. */
const QUIET_ZONE = 4;

/**
 * (COMPANION-PAIRING-UI) Renders a QR symbol as one SVG path.
 *
 * ALWAYS DARK-ON-WHITE, never the theme's colours. The app has a dark mode, and
 * a QR drawn in `foreground on background` inverts there — some decoders cope
 * with an inverted symbol and some return nothing at all, which would present
 * as "my phone just won't scan it" on exactly half of the installs. The white
 * plate is part of the symbol, not decoration.
 *
 * One `<path>` rather than a rect per module: a version-9 symbol is ~2 800
 * modules, and that many elements is a visible cost every time the countdown
 * re-renders the dialog.
 */
export function QrCode({ value, label, className }: QrCodeProps) {
	const { size, path } = useMemo(() => {
		const matrix = encodeQrMatrix(new TextEncoder().encode(value));
		const segments: string[] = [];
		for (let y = 0; y < matrix.size; y++) {
			for (let x = 0; x < matrix.size; x++) {
				if (matrix.modules[y * matrix.size + x]) {
					segments.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
				}
			}
		}
		return { size: matrix.size + QUIET_ZONE * 2, path: segments.join("") };
	}, [value]);

	return (
		<svg
			viewBox={`0 0 ${size} ${size}`}
			className={className}
			role="img"
			aria-label={label}
			shapeRendering="crispEdges"
		>
			<rect width={size} height={size} fill="#ffffff" />
			<path d={path} fill="#000000" />
		</svg>
	);
}
