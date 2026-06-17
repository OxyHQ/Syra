import React, { useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { FlatList as RNFlatList, FlatListProps, NativeSyntheticEvent, NativeScrollEvent, Platform, RefreshControlProps } from 'react-native';
import { LegendList as RL, LegendListProps, LegendListRef } from '@legendapp/list';
import LayoutScrollContext from '@/context/LayoutScrollContext';

type ScrollableRef = {
    scrollToOffset?: (params: { offset: number; animated?: boolean }) => void;
    scrollTo?: (params: { x?: number; y?: number; animated?: boolean }) => void;
};

type WheelEvent = {
    deltaY?: number;
    preventDefault?: () => void;
    target?: EventTarget | null;
    nativeEvent?: {
        deltaY?: number;
        preventDefault?: () => void;
        target?: EventTarget | null;
    };
};

type WebDataSet = Record<string, string>;

type WebExtensions = {
    dataSet?: WebDataSet;
    onWheel?: (event: WheelEvent) => void;
};

type LegendListWrapperProps<T> = LegendListProps<T> & WebExtensions;

function LegendListInner<T>(
    props: LegendListWrapperProps<T>,
    ref: React.ForwardedRef<LegendListRef>
): React.ReactElement {
    const {
        refreshControl,
        scrollEnabled = true,
        onScroll: propOnScroll,
        scrollEventThrottle: propScrollEventThrottle,
        dataSet,
        onWheel: propOnWheel,
        ...rest
    } = props;

    const layoutScroll = useContext(LayoutScrollContext);
    const localRef = useRef<LegendListRef | null>(null);
    const unregisterRef = useRef<(() => void) | null>(null);

    const clearRegistration = useCallback(() => {
        if (unregisterRef.current) {
            unregisterRef.current();
            unregisterRef.current = null;
        }
    }, []);

    const combinedRef = useCallback((node: LegendListRef | null) => {
        localRef.current = node;
        if (typeof ref === 'function') {
            ref(node);
        } else if (ref && typeof ref === 'object') {
            ref.current = node;
        }
    }, [ref]);

    useEffect(() => {
        if (!layoutScroll?.registerScrollable || scrollEnabled === false) {
            clearRegistration();
            return;
        }
        if (localRef.current) {
            unregisterRef.current = layoutScroll.registerScrollable(localRef.current as unknown as ScrollableRef);
        }
        return () => {
            clearRegistration();
        };
    }, [clearRegistration, layoutScroll?.registerScrollable, scrollEnabled]);

    const handleScroll = layoutScroll?.handleScroll;

    const mergedOnScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        if (scrollEnabled !== false && handleScroll) {
            handleScroll(event);
        }
        if (typeof propOnScroll === 'function') {
            propOnScroll(event);
        }
    }, [handleScroll, propOnScroll, scrollEnabled]);

    const handleWheelEvent = useCallback((event: WheelEvent) => {
        if (layoutScroll?.forwardWheelEvent) {
            layoutScroll.forwardWheelEvent(event);
        }
        if (typeof propOnWheel === 'function') {
            propOnWheel(event);
        }
    }, [layoutScroll?.forwardWheelEvent, propOnWheel]);

    const effectiveScrollEventThrottle = useMemo(() => {
        if (propScrollEventThrottle != null) return propScrollEventThrottle;
        return layoutScroll?.scrollEventThrottle;
    }, [layoutScroll?.scrollEventThrottle, propScrollEventThrottle]);

    const datasetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return dataSet;
        return { ...(dataSet || {}), layoutscroll: 'true' };
    }, [dataSet]);

    if (RL) {
        const defaults = {
            recycleItems: true,
            maintainVisibleContentPosition: false,
        };

        const propsForRL = {
            ...defaults,
            ...rest,
            refreshControl,
            scrollEnabled,
            onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
            dataSet: datasetForWeb,
            onWheel: Platform.OS === 'web' ? handleWheelEvent : propOnWheel,
            scrollEventThrottle: effectiveScrollEventThrottle ?? undefined,
        };

        return <RL ref={combinedRef} {...propsForRL} />;
    }

    const fallbackProps = {
        ...rest,
        refreshControl: refreshControl as React.ReactElement<RefreshControlProps> | undefined,
        scrollEnabled,
        onScroll: layoutScroll ? mergedOnScroll : propOnScroll,
        scrollEventThrottle: effectiveScrollEventThrottle ?? undefined,
    } as FlatListProps<T>;

    const webProps = Platform.OS === 'web' ? {
        dataSet: datasetForWeb,
        onWheel: handleWheelEvent,
    } : {};

    return <RNFlatList ref={combinedRef as React.Ref<RNFlatList<T>>} {...fallbackProps} {...webProps} />;
}

const LegendList = React.forwardRef(LegendListInner) as <T>(
    props: LegendListWrapperProps<T> & React.RefAttributes<LegendListRef>
) => React.ReactElement;

export default LegendList;
