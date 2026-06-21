/**
 * Agent Message Queue - Universal service for agent communication
 * Decouples nodes from MCP protocol through message accumulation
 */

import { createLogger } from "@mcp-moira/shared";

// Message types for different scenarios
export enum AgentMessageType {
  DIRECTIVE = "directive",
  NOTIFICATION = "notification",
}

// Base message structure
interface BaseAgentMessage {
  nodeId: string;
  messageId: string;
}

// Directive message (normal agent tasks)
export interface DirectiveMessage extends BaseAgentMessage {
  type: AgentMessageType.DIRECTIVE;
  directive: string;
  completionCondition: string;
  inputSchema?: Record<string, unknown>;
}

// Notification message (telegram send failures, etc.)
export interface NotificationMessage extends BaseAgentMessage {
  type: AgentMessageType.NOTIFICATION;
  notificationText: string;
  status: string;
}

// Union type
export type AgentMessage = DirectiveMessage | NotificationMessage;

// Queue response when flushing messages
export interface AgentQueueResponse {
  processId: string;
  messages: AgentMessage[];
  totalMessages: number;
}

export class AgentMessageQueue {
  private messages: AgentMessage[] = [];
  private logger = createLogger({ component: "AgentMessageQueue" });
  private messageCounter = 0;

  /**
   * Add message to queue (updated with type support)
   */
  addMessage(
    nodeId: string,
    directive: string,
    completionCondition: string,
    inputSchema?: Record<string, unknown>,
    type: AgentMessageType = AgentMessageType.DIRECTIVE,
  ): void {
    const messageId = `msg-${++this.messageCounter}`;

    let message: AgentMessage;

    if (type === AgentMessageType.DIRECTIVE) {
      message = {
        type: AgentMessageType.DIRECTIVE,
        nodeId,
        messageId,
        directive,
        completionCondition,
        inputSchema,
      } as DirectiveMessage;
    } else {
      message = {
        type: AgentMessageType.NOTIFICATION,
        nodeId,
        messageId,
        notificationText: directive,
        status: completionCondition,
      } as NotificationMessage;
    }

    this.messages.push(message);

    this.logger.debug("Message added to queue", {
      messageId,
      nodeId,
      type,
      queueLength: this.messages.length,
      directive: directive.substring(0, 50) + "...",
    });
  }

  /**
   * Add notification message (telegram send failures, etc.)
   */
  addNotification(nodeId: string, notificationText: string, status: string): void {
    const messageId = `msg-${++this.messageCounter}`;

    const message: NotificationMessage = {
      type: AgentMessageType.NOTIFICATION,
      nodeId,
      messageId,
      notificationText,
      status,
    };

    this.messages.push(message);

    this.logger.debug("Notification message added to queue", {
      messageId,
      nodeId,
      queueLength: this.messages.length,
      notificationText: notificationText.substring(0, 50) + "...",
    });
  }

  /**
   * Flush all messages and send to agent
   */
  flush(processId: string): AgentQueueResponse {
    const messagesToSend = [...this.messages];
    const messageCount = messagesToSend.length;

    // Clear queue
    this.messages = [];

    this.logger.info("Message queue flushed", {
      processId: processId.slice(0, 8),
      messageCount,
      messageIds: messagesToSend.map((m) => m.messageId),
    });

    return {
      processId,
      messages: messagesToSend,
      totalMessages: messageCount,
    };
  }

  /**
   * Check if queue has messages
   */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /**
   * Get current queue length
   */
  getLength(): number {
    return this.messages.length;
  }

  /**
   * Peek at next message without removing
   */
  peekNext(): AgentMessage | null {
    return this.messages[0] || null;
  }

  /**
   * Clear queue without sending
   */
  clear(): void {
    const clearedCount = this.messages.length;
    this.messages = [];

    this.logger.debug("Queue cleared", { clearedCount });
  }

  /**
   * Get queue state for debugging
   */
  getQueueState(): {
    length: number;
    messages: Pick<AgentMessage, "messageId" | "nodeId">[];
  } {
    return {
      length: this.messages.length,
      messages: this.messages.map((m) => ({
        messageId: m.messageId,
        nodeId: m.nodeId,
      })),
    };
  }
}
