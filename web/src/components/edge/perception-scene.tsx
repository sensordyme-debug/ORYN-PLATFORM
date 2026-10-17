import { CHAIR_BOX, HEDGE, ZONE, depthScale, type Pt } from "@/components/edge/perception-sim";

/**
 * The camera's view: an original line drawing of a backyard seen from a
 * wall-mounted unit. Deliberately schematic — the story is the overlays.
 */
export function SceneBackdrop() {
  const stroke = "rgb(242 241 237 / 0.22)";
  const faint = "rgb(242 241 237 / 0.1)";
  return (
    <g fill="none" stroke={stroke} strokeWidth="1.2" vectorEffect="non-scaling-stroke">
      {/* Fence along the back */}
      <path d="M0 158H960M0 112H960" />
      {Array.from({ length: 25 }, (_, i) => (
        <path key={i} d={`M${i * 40} 104V164`} stroke={faint} />
      ))}
      {/* Tree */}
      <path d="M868 160V96" />
      <circle cx="868" cy="70" r="46" stroke={faint} />
      <circle cx="840" cy="86" r="30" stroke={faint} />
      {/* Patio door, left */}
      <path d="M22 330V150L120 160V318Z" />
      <path d="M71 155V324" stroke={faint} />
      {/* Deck boards receding */}
      {[200, 232, 268, 310, 358, 414, 478, 552].map((y) => (
        <path key={y} d={`M0 ${y}H960`} stroke={faint} />
      ))}
      {/* Pool: coping and water line */}
      <path d="M380 300H760L880 530H300Z" />
      <path d="M392 310H748L862 520H318Z" stroke={faint} />
      {[0.25, 0.5, 0.75].map((k) => (
        <path key={k} d={`M${392 + (318 - 392) * k} ${310 + 210 * k}H${748 + (862 - 748) * k}`} stroke="rgb(242 241 237 / 0.05)" />
      ))}
      {/* Lounge chair (static object) */}
      <path d={`M${CHAIR_BOX.x + 8} ${CHAIR_BOX.y + 60}L${CHAIR_BOX.x + 30} ${CHAIR_BOX.y + 8}L${CHAIR_BOX.x + 52} ${CHAIR_BOX.y + 12}L${CHAIR_BOX.x + 38} ${CHAIR_BOX.y + 44}H${CHAIR_BOX.x + 112}`} />
      <path d={`M${CHAIR_BOX.x + 20} ${CHAIR_BOX.y + 44}V${CHAIR_BOX.y + 74}M${CHAIR_BOX.x + 104} ${CHAIR_BOX.y + 44}V${CHAIR_BOX.y + 74}`} />
    </g>
  );
}

/** Drawn after people so it hides whoever walks behind it. */
export function SceneHedge() {
  const { x0, x1, y0, y1 } = HEDGE;
  return (
    <g>
      <rect x={x0} y={y0} width={x1 - x0} height={y1 - y0} rx="10" fill="#0b0d0e" stroke="rgb(242 241 237 / 0.22)" strokeWidth="1.2" />
      {[0, 1, 2, 3, 4, 5].map((r) => (
        <path
          key={r}
          d={`M${x0 + 8} ${y0 + 16 + r * 21}q12 -8 24 0t24 0`}
          fill="none"
          stroke="rgb(242 241 237 / 0.09)"
          strokeWidth="1.2"
        />
      ))}
    </g>
  );
}

/** A schematic person standing or walking, positioned by the feet point. */
export function Person({ at, phase, moving }: { at: Pt; phase: number; moving: boolean }) {
  const [x, y] = at;
  const s = depthScale(y);
  const swing = moving ? Math.sin(phase) * 14 : 0;
  const fill = "rgb(220 217 209 / 0.55)";
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx="0" cy="0" rx="22" ry="5" fill="rgb(0 0 0 / 0.35)" />
      <g stroke={fill} strokeWidth="11" strokeLinecap="round">
        <path d={`M-6 -70L${-6 + swing} -4`} />
        <path d={`M6 -70L${6 - swing} -4`} />
        <path d={`M-17 -122L${-20 - swing * 0.6} -76`} strokeWidth="8" />
        <path d={`M17 -122L${20 + swing * 0.6} -76`} strokeWidth="8" />
      </g>
      <rect x="-19" y="-130" width="38" height="66" rx="13" fill={fill} />
      <circle cx="0" cy="-146" r="13" fill={fill} />
    </g>
  );
}

export function zonePath() {
  return `M${ZONE.map((p) => p.join(" ")).join("L")}Z`;
}
