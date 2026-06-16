import { Text, type TextProps } from "react-native";
import { cn } from "@/lib/utils";

const TYPE_CLASSES: Record<string, string> = {
  default: "text-base leading-6 font-sans",
  defaultSemiBold: "text-base leading-6 font-semibold font-sans",
  title: "text-[32px] leading-8 font-bold font-sans",
  subtitle: "text-xl font-bold font-sans",
  link: "text-base leading-[30px] font-sans text-primary",
};

export type ThemedTextProps = TextProps & {
  className?: string;
  type?: "default" | "title" | "defaultSemiBold" | "subtitle" | "link";
};

export function ThemedText({
  style,
  className,
  type = "default",
  ...rest
}: ThemedTextProps) {
  return (
    <Text
      className={cn("text-foreground", TYPE_CLASSES[type], className)}
      style={style}
      {...rest}
    />
  );
}
