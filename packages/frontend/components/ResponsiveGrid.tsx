import React, { useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

interface ResponsiveGridProps {
  children: React.ReactNode;
  minItemWidth: number;
  minColumns?: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  itemStyle?: StyleProp<ViewStyle>;
}

export function getResponsiveGridLayout({
  containerWidth,
  minItemWidth,
  minColumns = 1,
  gap,
}: {
  containerWidth: number;
  minItemWidth: number;
  minColumns?: number;
  gap: number;
}) {
  const minimumColumns = Math.max(1, Math.floor(minColumns));

  if (containerWidth <= 0) {
    return { columns: minimumColumns, itemWidth: minItemWidth };
  }

  const columns = Math.max(
    minimumColumns,
    Math.floor((containerWidth + gap) / (minItemWidth + gap)),
  );
  const itemWidth = Math.max(
    1,
    Math.floor((containerWidth - gap * (columns - 1)) / columns),
  );

  return { columns, itemWidth };
}

export function ResponsiveGrid({
  children,
  minItemWidth,
  minColumns = 1,
  gap = 8,
  style,
  itemStyle,
}: ResponsiveGridProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const items = useMemo(() => React.Children.toArray(children), [children]);

  const layout = useMemo(() => {
    return getResponsiveGridLayout({ containerWidth, gap, minItemWidth, minColumns });
  }, [containerWidth, gap, minColumns, minItemWidth]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextWidth = Math.floor(event.nativeEvent.layout.width);
    setContainerWidth((currentWidth) => (
      Math.abs(currentWidth - nextWidth) > 1 ? nextWidth : currentWidth
    ));
  };

  return (
    <View onLayout={handleLayout} style={[styles.grid, style]}>
      {items.map((child, index) => {
        const isLastColumn = (index + 1) % layout.columns === 0;
        return (
          <View
            key={React.isValidElement(child) ? child.key ?? index : index}
            style={[
              styles.item,
              {
                flexBasis: layout.itemWidth,
                marginRight: isLastColumn ? 0 : gap,
                marginBottom: gap,
              },
              itemStyle,
            ]}
          >
            {child}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
    minWidth: 0,
  },
  item: {
    alignSelf: 'stretch',
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
  },
});
