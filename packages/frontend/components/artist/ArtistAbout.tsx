import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { EntityProfile } from '@syra/shared-types';

interface ArtistAboutProps {
  entity: EntityProfile;
  hasImage: boolean;
  onNavigateArtist: (id: string) => void;
  onOpenLink: (url: string) => void;
}

/** Render stored facts only. Partial dates stay partial; missing end dates are not "present". */
export function ArtistAbout({ entity, hasImage, onNavigateArtist, onOpenLink }: ArtistAboutProps) {
  const { t } = useTranslation();
  const licence = hasImage ? entity.imageLicence : undefined;
  const facts = [
    { label: t('artist.activeFrom'), value: entity.activeFrom },
    { label: t('artist.activeUntil'), value: entity.activeUntil },
    { label: t('artist.aliases'), value: entity.aliases?.join(', ') },
    { label: t('artist.labels'), value: entity.labels?.join(', ') },
  ].filter((fact) => fact.value);
  if (!entity.bio && !entity.disambiguation && facts.length === 0 && !entity.members?.length && !licence) return null;

  return (
    <View className="px-6 py-6 gap-4 max-w-4xl">
      <Text accessibilityRole="header" className="text-foreground text-2xl font-bold">{t('common.about')}</Text>
      {entity.bio ? <Text selectable className="text-foreground text-base leading-6">{entity.bio}</Text> : null}
      {entity.disambiguation ? <Text selectable className="text-muted-foreground">{entity.disambiguation}</Text> : null}
      {facts.map((fact) => (
        <View key={fact.label} className="gap-1">
          <Text className="text-muted-foreground">{fact.label}</Text>
          <Text selectable className="text-foreground">{fact.value}</Text>
        </View>
      ))}
      {entity.members?.length ? (
        <View className="gap-2">
          <Text className="text-muted-foreground">{t('artist.members')}</Text>
          {entity.members.map((member, index) => (
            <View key={`${member.nameKey}:${index}`} className="gap-1">
              {member.catalogEntityId ? (
                <Pressable accessibilityRole="link" onPress={() => { if (member.catalogEntityId) onNavigateArtist(member.catalogEntityId); }}>
                  <Text className="text-primary text-base">{member.name}</Text>
                </Pressable>
              ) : <Text selectable className="text-foreground text-base">{member.name}</Text>}
              {member.from ? <Text className="text-muted-foreground">{t('artist.memberFrom', { date: member.from })}</Text> : null}
              {member.until ? <Text className="text-muted-foreground">{t('artist.memberUntil', { date: member.until })}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}
      {licence ? (
        <View className="gap-2">
          <Text className="text-muted-foreground">{t('artist.imageCredit')}</Text>
          <Text selectable className="text-foreground">{licence.attribution}</Text>
          {licence.licenceUrl && /^https?:\/\//i.test(licence.licenceUrl) ? (
            <Pressable accessibilityRole="link" onPress={() => { if (licence.licenceUrl) onOpenLink(licence.licenceUrl); }}>
              <Text className="text-primary">{licence.licence}</Text>
            </Pressable>
          ) : <Text selectable className="text-foreground">{licence.licence}</Text>}
          {/^https?:\/\//i.test(licence.sourceUrl) ? (
            <Pressable accessibilityRole="link" onPress={() => onOpenLink(licence.sourceUrl)}>
              <Text className="text-primary">{t('artist.imageSource')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
