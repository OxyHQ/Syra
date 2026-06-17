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
  maxItemWidth?: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  itemStyle?: StyleProp<ViewStyle>;
}

export function ResponsiveGrid({
  children,
  minItemWidth,
  maxItemWidth,
  gap = 8,
  style,
  itemStyle,
}: ResponsiveGridProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const items = useMemo(() => React.Children.toArray(children), [children]);

  const layout = useMemo(() => {
    if (containerWidth <= 0) {
      return { columns: 1, itemWidth: minItemWidth };
    }

    const maxColumnsByMinWidth = Math.max(
      1,
      Math.floor((containerWidth + gap) / (minItemWidth + gap)),
    );
    let columns = maxColumnsByMinWidth;
    let itemWidth = (containerWidth - gap * (columns - 1)) / columns;

    if (maxItemWidth && itemWidth > maxItemWidth) {
      const columnsByMaxWidth = Math.floor((containerWidth + gap) / (maxItemWidth + gap));
      columns = Math.max(1, Math.min(maxColumnsByMinWidth, columnsByMaxWidth || 1));
      itemWidth = (containerWidth - gap * (columns - 1)) / columns;
    }

    return { columns, itemWidth };
  }, [containerWidth, gap, maxItemWidth, minItemWidth]);

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
                width: layout.itemWidth,
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
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'stretch',
  },
  item: {
    minWidth: 0,
  },
});
