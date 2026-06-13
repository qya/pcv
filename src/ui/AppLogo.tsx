type AppLogoProps = {
  size?: number;
  className?: string;
};

export function AppLogo({ size = 32, className = "" }: AppLogoProps) {
  return (
    <img
      src="/android-chrome-192x192.png"
      alt="Point Cloud Video"
      width={size}
      height={size}
      className={className}
      draggable={false}
    />
  );
}
