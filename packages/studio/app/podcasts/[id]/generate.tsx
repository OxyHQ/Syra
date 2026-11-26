import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { toast } from '@oxy.so/bloom/toast';
import type { EpisodeGeneration, GenerationFormat } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { usePodcast } from '@/hooks/usePodcasts';
import { useGenerateEpisode, useGenerations } from '@/hooks/useGenerations';
import { getApiErrorMessage } from '@/utils/api';
import { cn } from '@/lib/utils';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const FORMATS: { value: GenerationFormat; label: string }[] = [
  { value: 'podcast', label: 'Conversation' },
  { value: 'interview', label: 'Interview' },
  { value: 'news', label: 'News' },
  { value: 'debate', label: 'Debate' },
  { value: 'explainer', label: 'Explainer' },
];

const STATUS_LABEL: Record<EpisodeGeneration['status'], string> = {
  queued: 'Queued',
  writing: 'Writing the script',
  recording: 'Recording',
  assembling: 'Assembling',
  publishing: 'Publishing',
  completed: 'Ready',
  failed: 'Failed',
};

function FormatSelector({
  value,
  onChange,
}: {
  value: GenerationFormat;
  onChange: (value: GenerationFormat) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Format</Text>
      <View style={styles.row}>
        {FORMATS.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            className={cn(
              'rounded-xl border px-3 py-2',
              option.value === value ? 'border-primary bg-primary/10' : 'border-border bg-surface',
            )}
          >
            <Text
              className={cn(
                'text-sm',
                option.value === value ? 'text-primary font-medium' : 'text-foreground',
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.mutedText}>
        Chosen once, with the first episode: it decides who speaks on the show.
      </Text>
    </View>
  );
}

function GenerationRow({ generation }: { generation: EpisodeGeneration }) {
  const styles = useStyles();
  const running = generation.status !== 'completed' && generation.status !== 'failed';
  return (
    <View style={styles.container}>
      <View style={styles.row2}>
        <Text numberOfLines={1} style={styles.text2}>
          {generation.topic ?? 'Choosing a subject…'}
        </Text>
        <Text
          className={cn(
            'text-xs',
            generation.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {running
            ? `${STATUS_LABEL[generation.status]} · ${generation.progress}%`
            : STATUS_LABEL[generation.status]}
        </Text>
      </View>
      {running ? (
        <View style={styles.surface}>
          <View style={[styles.surface2, { width: `${generation.progress}%` }]} />
        </View>
      ) : null}
      {generation.error ? <Text style={styles.text3}>{generation.error}</Text> : null}
    </View>
  );
}

function GenerationsSkeleton() {
  const styles = useStyles();
  return (
    <View style={styles.stack}>
      {[0, 1, 2].map((row) => (
        <Skeleton.Box key={row} width="100%" height={36} borderRadius={8} />
      ))}
    </View>
  );
}

function GenerateEpisode({ id }: { id: string }) {
  const styles = useStyles();
  const router = useRouter();
  const show = usePodcast(id);
  const generations = useGenerations(id);
  const generate = useGenerateEpisode(id);
  const [topic, setTopic] = useState('');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [brief, setBrief] = useState<string | null>(null);
  const [format, setFormat] = useState<GenerationFormat>('podcast');

  // A show's first generated episode sets what it is about and who speaks.
  const first = generations.data?.length === 0;
  const briefValue = brief ?? show.data?.podcast.description ?? '';

  const onGenerate = useCallback(() => {
    generate.mutate(
      {
        ...(topic.trim() ? { topic: topic.trim() } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(notes.trim() ? { notes } : {}),
        ...(first && briefValue.trim() ? { brief: briefValue.trim(), format } : {}),
      },
      {
        onSuccess: () => {
          toast.success('Generating your episode. It takes a few minutes.');
          setTopic('');
          setTitle('');
          setNotes('');
        },
        onError: (error) => {
          toast.error(getApiErrorMessage(error, 'Could not start the episode. Please try again.'));
        },
      },
    );
  }, [briefValue, first, format, generate, notes, title, topic]);

  return (
    <ScreenContainer
      title="Generate an episode"
      subtitle={show.data?.podcast.title}
      onBack={() => router.back()}
    >
      <Text style={styles.mutedText2}>
        Syra writes and voices a new episode of this show. Leave everything empty and it picks the
        next subject from what the show is about and what earlier episodes covered.
      </Text>

      {generations.isPending ? (
        <View style={styles.section}>
          <Skeleton.Box width="100%" height={96} borderRadius={12} />
        </View>
      ) : first ? (
        <>
          <FormField
            label="What the show is about"
            value={briefValue}
            onChangeText={setBrief}
            placeholder="A weekly look at…"
            multiline
            hint="Every episode's subject comes from this. The more it says, the more the show has to talk about."
          />
          <FormatSelector value={format} onChange={setFormat} />
        </>
      ) : null}

      <FormField
        label="Subject (optional)"
        value={topic}
        onChangeText={setTopic}
        placeholder="Let Syra choose"
      />
      <FormField
        label="Title (optional)"
        value={title}
        onChangeText={setTitle}
        placeholder="Named from the finished script"
      />
      <FormField
        label="Source material (optional)"
        value={notes}
        onChangeText={setNotes}
        placeholder="Paste an article or notes to work from"
        multiline
      />

      <Button
        onPress={onGenerate}
        disabled={generate.isPending || generations.isPending || (first && !briefValue.trim())}
        loading={generate.isPending}
        tone="accent"
        appearance="solid"
        testID="generate-episode-button"
      >
        Generate episode
      </Button>

      <Text style={styles.title}>Generated episodes</Text>
      {generations.isPending ? (
        <GenerationsSkeleton />
      ) : generations.isError ? (
        <Text style={styles.mutedText3}>Couldn&apos;t load them.</Text>
      ) : generations.data.length === 0 ? (
        <Text style={styles.mutedText3}>None yet.</Text>
      ) : (
        generations.data.map((generation) => (
          <GenerationRow key={generation.episodeId} generation={generation} />
        ))
      )}
    </ScreenContainer>
  );
}

export default function GenerateEpisodeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SignInGate>{id ? <GenerateEpisode id={id} /> : null}</SignInGate>;
}

const useStyles = createTokenStyles((t) => ({
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mutedText: { marginTop: 4, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  container: { borderBottomWidth: 1, borderColor: t.border, paddingVertical: 12 },
  row2: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text2: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: 14,
    color: t.foreground,
    lineHeight: 20,
  },
  surface: {
    marginTop: 8,
    height: 4,
    overflow: 'hidden',
    borderRadius: 9999,
    backgroundColor: t.border,
  },
  surface2: { height: 4, backgroundColor: t.primary },
  text3: { marginTop: 4, fontSize: 12, color: t.destructive, lineHeight: 16 },
  stack: { gap: 12 },
  mutedText2: { marginBottom: 16, fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
  title: {
    marginTop: 32,
    marginBottom: 4,
    fontSize: 16,
    fontWeight: 600,
    color: t.foreground,
    lineHeight: 24,
  },
  mutedText3: { fontSize: 14, color: t.mutedForeground, lineHeight: 20 },
}));
