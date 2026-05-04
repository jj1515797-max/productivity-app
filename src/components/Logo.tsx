export default function Logo({ height = 38 }: { height?: number }) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}image.png`}
      alt="순수본"
      height={height}
      style={{ height, width: 'auto', display: 'block' }}
    />
  );
}
