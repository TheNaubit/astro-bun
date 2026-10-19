const storage = new Map()

export default () => ({
  async getItem(key) {
    return storage.get(key)
  },
  async setItem(key, value) {
    storage.set(key, value)
  },
  async removeItem(key) {
    storage.delete(key)
  },
})
