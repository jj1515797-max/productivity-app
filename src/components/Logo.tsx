import logoUrl from '../../image.png';

export default function Logo({ height = 38 }: { height?: number }) {
  return (
    <img
      src={logoUrl}
      alt="순수본"
      height={height}
      style={{ height, width: 'auto', display: 'block' }}
    />
  );
}
