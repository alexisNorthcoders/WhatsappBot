export default function Input({setSubmit,setInputValue,inputValue,setReadingStream}) {
  
  

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };
  const handleClick = (event) => {
    event.preventDefault()
    setReadingStream(true)
    setSubmit(inputValue)

    setInputValue("")
  };

  return (
    <div id="input-container">
        <form onSubmit={handleClick}>
      <textarea
        type="text"
        placeholder="Enter text here"
        value={inputValue}
        onChange={handleInputChange}
        className="input-box"
      />
      <button className="submit-button">
        Submit
      </button>
      </form>
    </div>
  );
}
