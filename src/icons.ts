import { LabIcon } from '@jupyterlab/ui-components';

import logoIconSvg from '../style/bucket-explorer-logo.svg';
import bucketLightSvg from '../style/bucket-light.svg';
import keyIconSvg from '../style/key-icon.svg';
import databaseIconSvg from '../style/database-icon.svg';

export const s3Icon = new LabIcon({
  name: 'bucket-explorer:icon',
  svgstr: logoIconSvg
});

export const bucketIcon = new LabIcon({
  name: 'bucket-explorer:bucket',
  svgstr: bucketLightSvg
});

export const keyIcon = new LabIcon({
  name: 'bucket-explorer:key',
  svgstr: keyIconSvg
});

export const databaseIcon = new LabIcon({
  name: 'bucket-explorer:database',
  svgstr: databaseIconSvg
});
