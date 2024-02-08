import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { dracula } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Card, Container, Col } from "react-bootstrap";

export default function ChatHistory({
  submit,
  readingStream,
  setReadingStream,
}) {
  const [history, setHistory] = useState([]);
  const chatHistoryRef = useRef(null);

  const fetchData = async (submitValue) => {
    setReadingStream(true);

    const response = await fetch("/gpt4", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userPrompt: submitValue }),
    });
    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();

    let conversation = "";

    const updateStream = async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          setReadingStream(false);
          break;
        }

        conversation += value;

        setHistory((prevHistory) => {
          const newHistory = [...prevHistory];
          if (
            newHistory.length &&
            newHistory[newHistory.length - 1].user === submit
          ) {
            newHistory[newHistory.length - 1].bot += value;
          } else {
            newHistory.push({ user: submit, bot: value });
          }

          return newHistory;
        });
      }
    };

    updateStream();
  };

  useEffect(() => {
    if (submit && readingStream) {
      fetchData(
        (JSON.stringify(history) ? JSON.stringify(history) : null) + submit
      );
    }
  }, [submit, readingStream]);

  return (
    <Container>
      <Col>
        <div ref={chatHistoryRef} style={{ height: "70vh", overflow: "auto" }}>
          {history.map((conversation, index) => (
            <Card bg="light" className="text-align-left" key={index}>
              <Card.Body>
                <Card.Header as="h6">User:</Card.Header>
                <Card.Text>{conversation.user}</Card.Text>
                <Card.Header as="h6">Bot:</Card.Header>
                <Card.Text>
                  <Markdown
                    children={conversation.bot}
                    components={{
                      code({ node, inline, className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || "");
                        return !inline && match ? (
                          <SyntaxHighlighter
                            style={dracula}
                            language={match[1]}
                            PreTag="div"
                            children={String(children).replace(/\n$/, "")}
                            {...props}
                          />
                        ) : (
                          <code className={className} {...props}>
                            {children}
                          </code>
                        );
                      },
                    }}
                  />
                </Card.Text>
              </Card.Body>
            </Card>
          ))}
        </div>
      </Col>
    </Container>
  );
}
