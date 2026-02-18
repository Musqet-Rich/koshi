import { Container, Spacer, Text } from '@mariozechner/pi-tui'
import { theme } from './theme.js'

export class ChatLog extends Container {
  private lastRole: string | null = null

  clearAll() {
    this.clear()
    this.lastRole = null
  }

  addUser(text: string) {
    if (this.lastRole && this.lastRole !== 'user') {
      this.addChild(new Spacer(1))
    }
    this.lastRole = 'user'
    this.addChild(new Text(theme.user(`> ${text}`), 1, 0))
  }

  addAssistant(text: string) {
    if (this.lastRole && this.lastRole !== 'assistant') {
      this.addChild(new Spacer(1))
    }
    this.lastRole = 'assistant'
    this.addChild(new Text(theme.assistant(`  ${text}`), 1, 0))
  }

  private streamingComponent: Text | null = null

  startAssistant(text: string) {
    if (this.lastRole && this.lastRole !== 'assistant') {
      this.addChild(new Spacer(1))
    }
    this.lastRole = 'assistant'
    const component = new Text(theme.assistant(`  ${text}`), 1, 0)
    this.streamingComponent = component
    this.addChild(component)
  }

  updateAssistant(text: string) {
    if (!this.streamingComponent) {
      this.startAssistant(text)
      return
    }
    this.streamingComponent.setText(theme.assistant(`  ${text}`))
  }

  finalizeAssistant(text: string) {
    if (this.streamingComponent) {
      this.streamingComponent.setText(theme.assistant(`  ${text}`))
      this.streamingComponent = null
      return
    }
    this.addAssistant(text)
  }

  addSystem(text: string) {
    if (this.lastRole) {
      this.addChild(new Spacer(1))
    }
    this.lastRole = 'system'
    this.addChild(new Text(theme.system(text), 1, 0))
  }
}
