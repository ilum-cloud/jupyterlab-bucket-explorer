const navigatorAny = navigator as Navigator & {
  clipboard?: {
    readText?: () => Promise<string>;
    writeText?: (data: string) => Promise<void>;
  };
};

if (!navigatorAny.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: {
      readText: jest.fn().mockResolvedValue(''),
      writeText: jest.fn().mockResolvedValue(undefined)
    },
    configurable: true
  });
}
