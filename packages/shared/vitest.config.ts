export default {
  test: {
    globals: true,
    // The Monte-Carlo RTP suites run 60k slips each — well past the 5s default.
    testTimeout: 30_000,
  },
};
