import { useState } from "react";
import { Package } from "lucide-react";

interface ProductImageProps {
  src: string;
  alt: string;
  className?: string;
}

export function ProductImage({ src, alt, className = "" }: ProductImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-[#ECEAE4] text-[#57534E] px-4 text-center ${className}`}
      >
        <Package className="w-7 h-7 mb-2 opacity-60" strokeWidth={1.5} />
        <span className="text-xs font-medium tracking-wide">{alt}</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
