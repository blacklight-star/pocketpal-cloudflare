import React, {useContext, useEffect, useState} from 'react';
import {View} from 'react-native';
import {
  Button,
  Snackbar,
  Text,
  TextInput as PaperTextInput,
} from 'react-native-paper';

import {Sheet, TextInput} from '..';
import {EyeIcon, EyeOffIcon} from '../../assets/icons';
import {useTheme} from '../../hooks';
import {cloudflareAdminStore} from '../../store';
import {L10nContext} from '../../utils';

interface CloudflareAdminKeySheetProps {
  isVisible: boolean;
  onDismiss: () => void;
}

export const CloudflareAdminKeySheet: React.FC<
  CloudflareAdminKeySheetProps
> = ({isVisible, onDismiss}) => {
  const theme = useTheme();
  const l10n = useContext(L10nContext);
  const strings = l10n.settings.cloudflareAdmin;
  const [key, setKey] = useState('');
  const [secureTextEntry, setSecureTextEntry] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (isVisible && cloudflareAdminStore.isKeyLoaded) {
      setKey(cloudflareAdminStore.getGatewayKey());
    }
  }, [isVisible]);

  const keyFormatValid = /^[A-Za-z0-9._~-]{32,256}$/.test(key.trim());

  const handleSave = async () => {
    if (!keyFormatValid) {
      return;
    }
    setIsSaving(true);
    try {
      const saved = await cloudflareAdminStore.setGatewayKey(key);
      if (saved) {
        onDismiss();
      } else {
        setShowError(true);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsClearing(true);
    try {
      const cleared = await cloudflareAdminStore.clearGatewayKey();
      if (cleared) {
        setKey('');
        onDismiss();
      } else {
        setShowError(true);
      }
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <Sheet
      isVisible={isVisible}
      onClose={onDismiss}
      title={strings.keySheetTitle}
      snapPoints={['50%']}>
      <Sheet.ScrollView contentContainerStyle={{padding: 16}}>
        <Text style={{color: theme.colors.onSurfaceVariant, marginBottom: 12}}>
          {strings.keyDescription}
        </Text>
        <TextInput
          testID="cloudflare-admin-key-input"
          label={strings.keySheetTitle}
          value={key}
          onChangeText={setKey}
          placeholder={strings.keyInputPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          secureTextEntry={secureTextEntry}
          error={key.trim().length > 0 && !keyFormatValid}
          helperText={
            key.trim().length > 0 && !keyFormatValid
              ? strings.keyLengthError
              : undefined
          }
          right={
            <PaperTextInput.Icon
              testID="cloudflare-admin-key-visibility"
              accessibilityLabel={
                secureTextEntry
                  ? l10n.settings.internetSearch.showKeyAccessibilityLabel
                  : l10n.settings.internetSearch.hideKeyAccessibilityLabel
              }
              icon={({color}) =>
                secureTextEntry ? (
                  <EyeIcon width={24} height={24} stroke={color} />
                ) : (
                  <EyeOffIcon width={24} height={24} stroke={color} />
                )
              }
              onPress={() => setSecureTextEntry(value => !value)}
            />
          }
        />
      </Sheet.ScrollView>
      <Sheet.Actions>
        <View style={{flexDirection: 'row', justifyContent: 'flex-end', gap: 8}}>
          {cloudflareAdminStore.hasGatewayKey && (
            <Button
              mode="text"
              onPress={handleClear}
              loading={isClearing}
              disabled={isSaving || isClearing}>
              {strings.clearKeyButton}
            </Button>
          )}
          <Button
            testID="cloudflare-admin-key-save"
            mode="contained"
            onPress={handleSave}
            loading={isSaving}
            disabled={isSaving || isClearing || !keyFormatValid}>
            {strings.saveKeyButton}
          </Button>
        </View>
      </Sheet.Actions>
      <Snackbar
        visible={showError}
        onDismiss={() => setShowError(false)}
        duration={3000}
        action={{
          label: l10n.common.dismiss,
          onPress: () => setShowError(false),
        }}>
        {strings.keyUpdateError}
      </Snackbar>
    </Sheet>
  );
};
