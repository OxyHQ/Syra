import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button } from '@oxy.so/bloom/button';
import { Switch } from '@oxy.so/bloom/switch';
import type { CreatePodcastRequest, PodcastType } from '@syra/shared-types';
import { SignInGate } from '@/components/SignInGate';
import { ScreenContainer } from '@/components/AppShell';
import { FormField } from '@/components/FormField';
import { HostsGuestsPicker, type HostsGuests } from '@/components/HostsGuestsPicker';
import { useCreatePodcast } from '@/hooks/usePodcasts';
import { extractInvalidIds } from '@/utils/api';
import { toast } from '@oxy.so/bloom/toast';
import { cn } from '@/lib/utils';
import { createTokenStyles } from '@oxy.so/bloom/theme';

const TYPES: { value: PodcastType; label: string; hint: string }[] = [
  { value: 'episodic', label: 'Episodic', hint: 'Standalone episodes, newest first' },
  { value: 'serial', label: 'Serial', hint: 'Meant to be heard in order' },
];

function TypeSelector({
  value,
  onChange,
}: {
  value: PodcastType;
  onChange: (value: PodcastType) => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text style={styles.text}>Podcast type</Text>
      <View style={styles.row}>
        {TYPES.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              className={cn(
                'flex-1 rounded-xl border px-3 py-3',
                active ? 'border-primary bg-primary/10' : 'border-border bg-surface',
              )}
            >
              <Text
                className={cn('text-sm font-semibold', active ? 'text-primary' : 'text-foreground')}
              >
                {option.label}
              </Text>
              <Text style={styles.mutedText}>{option.hint}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function CreateShowForm() {
  const styles = useStyles();
  const router = useRouter();
  const createPodcast = useCreatePodcast();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [author, setAuthor] = useState('');
  const [image, setImage] = useState('');
  const [language, setLanguage] = useState('en');
  const [categories, setCategories] = useState('');
  const [type, setType] = useState<PodcastType>('episodic');
  const [explicit, setExplicit] = useState(false);
  const [hostsGuests, setHostsGuests] = useState<HostsGuests>({ hosts: [], guests: [] });
  const [titleError, setTitleError] = useState<string | undefined>(undefined);

  const onSubmit = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setTitleError('A podcast title is required');
      return;
    }
    setTitleError(undefined);

    const categoryList = categories
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const hostIds = hostsGuests.hosts.map((u) => u.id);
    const guestIds = hostsGuests.guests.map((u) => u.id);

    const payload: CreatePodcastRequest = {
      title: trimmedTitle,
      description: description.trim() || undefined,
      author: author.trim() || undefined,
      image: image.trim() || undefined,
      language: language.trim() || undefined,
      categories: categoryList.length > 0 ? categoryList : undefined,
      explicit,
      type,
      hosts: hostIds.length > 0 ? hostIds : undefined,
      guests: guestIds.length > 0 ? guestIds : undefined,
    };

    try {
      const created = await createPodcast.mutateAsync(payload);
      toast.success('Podcast created');
      router.replace({ pathname: '/podcasts/[id]', params: { id: created.id } });
    } catch (error) {
      const invalidIds = extractInvalidIds(error);
      if (invalidIds) {
        toast.error('Some hosts/guests are not valid Oxy users. Remove them and try again.');
      } else {
        toast.error('Could not create the podcast. Please try again.');
      }
    }
  }, [
    title,
    description,
    author,
    image,
    language,
    categories,
    explicit,
    type,
    hostsGuests,
    createPodcast,
    router,
  ]);

  return (
    <ScreenContainer
      title="New podcast"
      subtitle="Create a Syra-hosted podcast"
      onBack={() => router.back()}
    >
      <FormField
        label="Title"
        placeholder="My amazing podcast"
        value={title}
        onChangeText={setTitle}
        error={titleError}
        maxLength={120}
      />
      <FormField
        label="Description"
        placeholder="What is your podcast about?"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <FormField
        label="Author / publisher"
        placeholder="Your name or organization"
        value={author}
        onChangeText={setAuthor}
        autoCapitalize="words"
      />
      <FormField
        label="Cover art URL"
        placeholder="https://example.com/cover.jpg"
        hint="A public image URL (1400–3000px square recommended)."
        value={image}
        onChangeText={setImage}
        autoCapitalize="none"
        keyboardType="url"
      />
      <View style={styles.row2}>
        <View style={styles.fill}>
          <FormField
            label="Language"
            placeholder="en"
            value={language}
            onChangeText={setLanguage}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.container}>
          <FormField
            label="Categories"
            placeholder="Technology, News"
            hint="Comma-separated (Apple categories)."
            value={categories}
            onChangeText={setCategories}
          />
        </View>
      </View>
      <TypeSelector value={type} onChange={setType} />
      <HostsGuestsPicker value={hostsGuests} onChange={setHostsGuests} />
      <View style={styles.row3}>
        <View style={styles.container2}>
          <Text style={styles.text2}>Explicit content</Text>
          <Text style={styles.mutedText}>Marks the feed as explicit in directories.</Text>
        </View>
        <Switch checked={explicit} onCheckedChange={setExplicit} />
      </View>
      <Button
        fullWidth
        onPress={onSubmit}
        loading={createPodcast.isPending}
        disabled={createPodcast.isPending}
        tone="accent"
        appearance="solid"
      >
        Create show
      </Button>
    </ScreenContainer>
  );
}

export default function NewShowScreen() {
  return (
    <SignInGate>
      <CreateShowForm />
    </SignInGate>
  );
}

const useStyles = createTokenStyles((t) => ({
  section: { marginBottom: 16 },
  text: { marginBottom: 6, fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
  row: { flexDirection: 'row', gap: 8 },
  mutedText: { marginTop: 2, fontSize: 12, color: t.mutedForeground, lineHeight: 16 },
  row2: { flexDirection: 'row', gap: 12 },
  fill: { flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  container: { flexGrow: 2, flexShrink: 1, flexBasis: '0%' },
  row3: {
    marginBottom: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.surface,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  container2: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', paddingRight: 12 },
  text2: { fontSize: 14, fontWeight: 500, color: t.foreground, lineHeight: 20 },
}));
