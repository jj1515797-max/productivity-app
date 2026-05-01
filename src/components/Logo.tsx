export default function Logo({ height = 38 }: { height?: number }) {
  return (
    <svg viewBox="0 0 80 50" height={height} width={height * 1.6} fill="none">
      <path
        d="M8 24 Q 40 -8, 72 24"
        stroke="#7cb342"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <text
        x="40"
        y="46"
        textAnchor="middle"
        fontSize="18"
        fontWeight="900"
        fill="#c0392b"
        letterSpacing="-0.5"
        fontFamily="-apple-system, 'Apple SD Gothic Neo', sans-serif"
      >
        순수본
      </text>
    </svg>
  );
}
